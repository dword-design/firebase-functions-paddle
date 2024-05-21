import {
  filter,
  first,
  map,
  omit,
  pick,
  property,
} from '@dword-design/functions'
import * as firebase from 'firebase-admin'
import * as functions from 'firebase-functions'
import PaddleSDK from 'paddle-sdk'

const collectionName = 'paddleUsers'
firebase.initializeApp()

const paddle = new PaddleSDK(
  functions.config().paddle.vendor_id |> parseInt,
  functions.config().paddle.api_key,
)

const getUserId = async paddleUser => {
  const userId =
    firebase
      .firestore()
      .collection(collectionName)
      .where('paddleUserId', '==', paddleUser.user_id)
      .get()
    |> await
    |> property('docs')
    |> first
    |> property('id')
  if (userId === undefined) {
    return (
      firebase.auth().getUserByEmail(paddleUser.email)
      |> await
      |> property('uid')
    )
  }

  return userId
}

export const planWritten = functions.firestore
  .document(`/${collectionName}/{uid}/subscriptions/{subscriptionId}`)
  .onWrite(async (change, context) => {
    const user = await firebase.auth().getUser(context.params.uid)
    if (change.after.exists) {
      const subscription = change.after.data()
      await firebase.auth().setCustomUserClaims(context.params.uid, {
        ...user.customClaims,
        paddlePlanId: subscription.subscription_plan_id,
        paddleSubscriptionId: subscription.subscription_id,
      })
    } else {
      await firebase
        .auth()
        .setCustomUserClaims(
          context.params.uid,
          user.customClaims |> omit('paddlePlanId'),
        )
    }
  })

export const userDeleted = functions.auth.user().onDelete(async user => {
  if (user.customClaims.paddleSubscriptionId !== undefined) {
    await paddle.cancelSubscription(user.customClaims.paddleSubscriptionId)
  }
})

export const webHook = functions.https.onRequest(async (req, res) => {
  switch (req.body.alert_name) {
    case 'subscription_created':
    case 'subscription_updated': {
      const userId = await getUserId(req.body)
      await firebase
        .firestore()
        .doc(`${collectionName}/${userId}`)
        .set({
          ...(req.body |> pick('email')),
          paddleUserId: req.body.user_id,
        })
      // delete artificial subscriptions when a real subscription is created
      if (req.body.alert_name === 'subscription_created') {
        const artificialSubscriptionIds =
          firebase
            .firestore()
            .collection(`${collectionName}/${userId}/subscriptions`)
            .get()
          |> await
          |> property('docs')
          |> filter(snapshot => snapshot.data().subscription_id === undefined)
          |> map('id')

        const batch = firebase.firestore().batch()
        for (const id of artificialSubscriptionIds) {
          batch.delete(
            firebase
              .firestore()
              .doc(`${collectionName}/${userId}/subscriptions/${id}`),
          )
        }
        await batch.commit()
      }
      await firebase
        .firestore()
        .doc(
          `${collectionName}/${userId}/subscriptions/${req.body.subscription_id}`,
        )
        .set(
          req.body
            |> pick([
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
        )
      break
    }
    case 'subscription_cancelled': {
      const userId = await getUserId(req.body)
      await firebase
        .firestore()
        .doc(
          `${collectionName}/${userId}/subscriptions/${req.body.subscription_id}`,
        )
        .delete()
      break
    }
    default:
  }
  res.end()
})
