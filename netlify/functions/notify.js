/**
 * Netlify Function: notify
 * Sends FCM push notifications when a participant completes their workout.
 * Uses Firebase Admin SDK (FCM HTTP v1 API) with a service account.
 *
 * Environment variable required (set in Netlify dashboard):
 *   FIREBASE_SERVICE_ACCOUNT = contents of your Firebase service account JSON
 */

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

function getAdminApp() {
  if (getApps().length > 0) return getApps()[0];
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn('[notify] FIREBASE_SERVICE_ACCOUNT not set — skipping notification');
    return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
  }

  let message, tokens;
  try {
    ({ message, tokens } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  if (!tokens?.length) {
    return { statusCode: 200, body: JSON.stringify({ sent: 0 }) };
  }

  try {
    const app = getAdminApp();
    const messaging = getMessaging(app);

    const messages = tokens.map((token) => ({
      token,
      notification: {
        title: 'Net Positive 💪',
        body: message,
      },
      webpush: {
        notification: {
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-72.png',
        },
        fcmOptions: { link: '/' },
      },
    }));

    const result = await messaging.sendEach(messages);
    console.log(`[notify] success:${result.successCount} failure:${result.failureCount}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: result.successCount, failure: result.failureCount }),
    };
  } catch (err) {
    console.error('[notify] Error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
