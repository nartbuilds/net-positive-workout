/**
 * Netlify Function: notify
 * Sends FCM push notifications when a participant completes their workout.
 * Runs server-side so the FCM server key never touches the client.
 *
 * Environment variable required (set in Netlify dashboard):
 *   FCM_SERVER_KEY = your Firebase Cloud Messaging server key
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY;
  if (!FCM_SERVER_KEY) {
    console.warn('[notify] FCM_SERVER_KEY not set — skipping notification');
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

  const payload = {
    registration_ids: tokens,
    notification: {
      title: 'Net Positive 💪',
      body: message,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-72.png',
    },
    data: { url: '/', message },
    priority: 'high',
  };

  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        Authorization: `key=${FCM_SERVER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    console.log(`[notify] success:${result.success} failure:${result.failure}`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('[notify] FCM error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
