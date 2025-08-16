import { Paddle } from '@paddle/paddle-node-sdk';
import firebase from 'firebase-admin';
import functions from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { omit, pick } from 'lodash-es';
import { PaddleSDK } from 'paddle-sdk';

interface Subscription {
  subscription_id: string;
  subscription_plan_id: string;
}
const collectionName = 'paddleUsers';
firebase.initializeApp();
const isPaddleBilling = !functions.config().paddle.vendor_id;

const paddleClassic = new PaddleSDK(
  functions.config().paddle.vendor_id,
  functions.config().paddle.api_key,
);

const paddleBilling = new Paddle(functions.config().paddle.api_key);

const cancelSubscription = (id: number) =>
  isPaddleBilling
    ? paddleBilling.subscriptions.cancel(String(id))
    : paddleClassic.cancelSubscription(id);

const getUserId = async (paddleUser: { user_id: string; email: string }) => {
  const {
    docs: [{ id: userId }],
  } = await firebase
    .firestore()
    .collection(collectionName)
    .where('paddleUserId', '==', paddleUser.user_id)
    .get();

  if (userId === undefined) {
    const firestoreUser = await firebase
      .auth()
      .getUserByEmail(paddleUser.email);

    return firestoreUser.uid;
  }

  return userId;
};

export const planWritten = onDocumentWritten(
  `/${collectionName}/{uid}/subscriptions/{subscriptionId}`,
  async event => {
    const user = await firebase.auth().getUser(event.params.uid);

    if (event.data?.after.exists) {
      const subscription = event.data.after.data() as Subscription;

      await firebase
        .auth()
        .setCustomUserClaims(event.params.uid, {
          ...user.customClaims,
          paddlePlanId: subscription.subscription_plan_id,
          paddleSubscriptionId: subscription.subscription_id,
        });
    } else {
      await firebase
        .auth()
        .setCustomUserClaims(
          event.params.uid,
          omit(user.customClaims, ['paddlePlanId']),
        );
    }
  },
);

export const userDeleted = functions.auth.user().onDelete(async user => {
  if (user.customClaims?.paddleSubscriptionId !== undefined) {
    await cancelSubscription(user.customClaims.paddleSubscriptionId);
  }
});

export const webHook = functions.https.onRequest(async (req, res) => {
  if (isPaddleBilling) {
    console.log(req.body);
    return;
  }

  switch (req.body.alert_name) {
    case 'subscription_created':

    case 'subscription_updated': {
      const userId = await getUserId(req.body);

      await firebase
        .firestore()
        .doc(`${collectionName}/${userId}`)
        .set({ ...pick(req.body, ['email']), paddleUserId: req.body.user_id });

      // delete artificial subscriptions when a real subscription is created
      if (req.body.alert_name === 'subscription_created') {
        const { docs: subscriptions } = await firebase
          .firestore()
          .collection(`${collectionName}/${userId}/subscriptions`)
          .get();

        const artificialSubscriptionIds = subscriptions
          .filter(snapshot => snapshot.data().subscription_id === undefined)
          .map(_ => _.id);

        const batch = firebase.firestore().batch();

        for (const id of artificialSubscriptionIds) {
          batch.delete(
            firebase
              .firestore()
              .doc(`${collectionName}/${userId}/subscriptions/${id}`),
          );
        }

        await batch.commit();
      }

      await firebase
        .firestore()
        .doc(
          `${collectionName}/${userId}/subscriptions/${req.body.subscription_id}`,
        )
        .set(
          pick(req.body, [
            'cancel_url',
            'checkout_id',
            'currency',
            'marketing_consent',
            'quantity',
            'status',
            'subscription_id',
            'subscription_plan_id',
            'unit_price',
            'update_url',
            'user_id',
          ]),
        );

      break;
    }

    case 'subscription_cancelled': {
      const userId = await getUserId(req.body);

      await firebase
        .firestore()
        .doc(
          `${collectionName}/${userId}/subscriptions/${req.body.subscription_id}`,
        )
        .delete();

      break;
    }

    default:
  }

  res.end();
});
