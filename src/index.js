import { first, omit, pick, property } from '@dword-design/functions'
import * as firebase from 'firebase-admin'
import * as functions from 'firebase-functions'

const collectionName = 'paddleUsers'
firebase.initializeApp()

export const planWritten = functions.firestore
  .document(`/${collectionName}/{uid}/subscriptions/{subscriptionId}`)
  .onWrite(async (change, context) => {
    const user = await firebase.auth().getUser(context.params.uid)
    if (change.after.exists) {
      await firebase.auth().setCustomUserClaims(context.params.uid, {
        ...user.customClaims,
        paddlePlanId: change.after.data().subscription_plan_id,
      })
    } else {
      await firebase
        .auth()
        .setCustomUserClaims(
          context.params.uid,
          user.customClaims |> omit('paddlePlanId')
        )
    }
  })

export const webHook = functions.https.onRequest(async (req, res) => {
  switch (req.body.alert_name) {
    case 'subscription_created':
    case 'subscription_updated': {
      const userId =
        (firebase
          .firestore()
          .collection(collectionName)
          .where('paddleUserId', '==', req.body.user_id)
          .get()
          |> await
          |> property('docs')
          |> first
          |> property('id')) ||
        (firebase.auth().getUserByEmail(req.body.email)
          |> await
          |> property('uid'))
      const paddleUserRef = firebase
        .firestore()
        .collection(collectionName)
        .doc(userId)
      await paddleUserRef.set({
        ...(req.body |> pick('email')),
        paddleUserId: req.body.user_id,
      })
      await paddleUserRef
        .collection('subscriptions')
        .doc(req.body.subscription_id)
        .set(
          req.body
            |> pick([
              'cancel_url',
              'checkout_id',
              'currency',
              'quantity',
              'status',
              'subscription_plan_id',
              'unit_price',
              'update_url',
            ])
        )
      break
    }
    case 'subscription_cancelled': {
      const userId =
        firebase
          .firestore()
          .collection(collectionName)
          .where('paddleUserId', '==', req.body.user_id)
          .get()
        |> await
        |> property('docs')
        |> first
        |> property('id')
      await firebase
        .firestore()
        .collection(collectionName)
        .doc(userId)
        .collection('subscriptions')
        .doc(req.body.subscription_id)
        .delete()
      break
    }
    default:
  }
  res.end()
})
