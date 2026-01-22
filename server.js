import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import morgan from 'morgan';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import webPush from 'web-push';
import { query, withClient } from './db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const {
  PORT = 5173,
  SESSION_SECRET,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
  INTERNAL_API_KEY
} = process.env;

if (!SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set; sessions will be insecure.');
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

app.use(morgan('dev'));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const TOPICS = ['trade_alerts', 'fills', 'risk_events', 'system'];

const createSessionCookie = (res, user) => {
  const token = jwt.sign({ userId: user.id }, SESSION_SECRET || 'dev-secret', {
    expiresIn: '7d'
  });

  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
};

const authMiddleware = async (req, res, next) => {
  const token = req.cookies.session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, SESSION_SECRET || 'dev-secret');
    const { rows } = await query('SELECT id, email, created_at FROM users WHERE id = $1', [payload.userId]);
    if (!rows[0]) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    req.user = rows[0];
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid session' });
  }
};

const ensureApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (!INTERNAL_API_KEY || apiKey !== INTERNAL_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
};

const upsertUserByEmail = async (email) => {
  const { rows } = await query(
    `INSERT INTO users (email)
     VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, created_at`,
    [email]
  );

  return rows[0];
};

const detectPlatform = (userAgent = '') => {
  if (/iphone|ipad|ipod/i.test(userAgent)) {
    return 'ios';
  }
  if (/android/i.test(userAgent)) {
    return 'android';
  }
  return 'web';
};

const normalizeTopics = (topics) => {
  if (!Array.isArray(topics)) {
    return [];
  }
  return topics.filter((topic) => TOPICS.includes(topic));
};

const mapSubscription = (subscription) => {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return null;
  }
  return {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth
  };
};

const sendPush = async ({ subscription, payload, deviceId, deviceServiceId }) => {
  try {
    await webPush.sendNotification(subscription, JSON.stringify(payload));
    return { success: true };
  } catch (error) {
    const statusCode = error.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await query('UPDATE push_devices SET is_active = false WHERE id = $1', [deviceId]);
      await query('UPDATE push_device_services SET disabled_at = NOW() WHERE device_id = $1', [deviceId]);
    }
    return { success: false, error: error.message };
  }
};

app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: VAPID_PUBLIC_KEY || '' });
});

app.post('/api/dev/login', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await upsertUserByEmail(email.toLowerCase());
    createSessionCookie(res, user);
    return res.json({ user });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/link/exchange', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { rows } = await query(
      `SELECT token, user_id, expires_at, used_at
       FROM push_link_tokens
       WHERE token = $1`,
      [token]
    );

    const record = rows[0];
    if (!record) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    if (record.used_at) {
      return res.status(400).json({ error: 'Token already used' });
    }
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Token expired' });
    }

    await query('UPDATE push_link_tokens SET used_at = NOW() WHERE token = $1', [token]);
    const { rows: userRows } = await query('SELECT id, email, created_at FROM users WHERE id = $1', [record.user_id]);
    const user = userRows[0];

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    createSessionCookie(res, user);
    return res.json({ user });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/me/services', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.name, s.domain_hint
       FROM user_service_access usa
       JOIN services s ON s.id = usa.service_id
       WHERE usa.user_id = $1 AND usa.status = 'active'
       ORDER BY s.name`,
      [req.user.id]
    );

    const services = rows.map((service) => ({
      ...service,
      topics: TOPICS
    }));

    res.json({ services });
  } catch (error) {
    next(error);
  }
});

app.post('/api/dev/grant-access', async (req, res, next) => {
  try {
    const { email, service_id } = req.body;
    if (!email || !service_id) {
      return res.status(400).json({ error: 'Email and service_id are required' });
    }

    const user = await upsertUserByEmail(email.toLowerCase());
    await query(
      `INSERT INTO user_service_access (user_id, service_id, status, role)
       VALUES ($1, $2, 'active', 'member')
       ON CONFLICT (user_id, service_id) DO UPDATE SET status = 'active'`,
      [user.id, service_id]
    );

    return res.json({ success: true, user });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/dev/create-link-token', async (req, res, next) => {
  try {
    const { email, expires_in_minutes = 30 } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await upsertUserByEmail(email.toLowerCase());
    const token = crypto.randomBytes(24).toString('hex');
    await query(
      `INSERT INTO push_link_tokens (token, user_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::INTERVAL)`,
      [token, user.id, `${expires_in_minutes}`]
    );

    return res.json({ token, expires_in_minutes });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/push/subscribe', authMiddleware, async (req, res, next) => {
  try {
    const { service_id, subscription, topics } = req.body;
    if (!service_id) {
      return res.status(400).json({ error: 'service_id is required' });
    }

    const mapped = mapSubscription(subscription);
    if (!mapped) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }

    const normalizedTopics = normalizeTopics(topics);
    const userAgent = req.headers['user-agent'] || '';
    const platform = detectPlatform(userAgent);

    const device = await withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO push_devices (user_id, endpoint, p256dh, auth, user_agent, platform, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)
         ON CONFLICT (endpoint)
         DO UPDATE SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           platform = EXCLUDED.platform,
           is_active = TRUE,
           last_seen_at = NOW()
         RETURNING id`,
        [req.user.id, mapped.endpoint, mapped.p256dh, mapped.auth, userAgent, platform]
      );

      const deviceId = result.rows[0].id;

      await client.query(
        `INSERT INTO push_device_services (device_id, service_id, topics_json, enabled_at, disabled_at)
         VALUES ($1, $2, $3::jsonb, NOW(), NULL)
         ON CONFLICT (device_id, service_id)
         DO UPDATE SET topics_json = EXCLUDED.topics_json,
           enabled_at = NOW(),
           disabled_at = NULL`,
        [deviceId, service_id, JSON.stringify(normalizedTopics)]
      );

      return { id: deviceId };
    });

    return res.json({ success: true, device_id: device.id });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/push/unsubscribe', authMiddleware, async (req, res, next) => {
  try {
    const { service_id, endpoint } = req.body;
    if (!service_id || !endpoint) {
      return res.status(400).json({ error: 'service_id and endpoint are required' });
    }

    const { rows } = await query('SELECT id FROM push_devices WHERE endpoint = $1 AND user_id = $2', [
      endpoint,
      req.user.id
    ]);

    const device = rows[0];
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    await query(
      `UPDATE push_device_services
       SET disabled_at = NOW()
       WHERE device_id = $1 AND service_id = $2`,
      [device.id, service_id]
    );

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/push/test', authMiddleware, async (req, res, next) => {
  try {
    const { service_id, endpoint } = req.body;
    if (!service_id) {
      return res.status(400).json({ error: 'service_id is required' });
    }

    const { rows } = await query(
      `SELECT pd.id AS device_id, pd.endpoint, pd.p256dh, pd.auth, pds.topics_json
       FROM push_devices pd
       JOIN push_device_services pds ON pd.id = pds.device_id
       WHERE pd.user_id = $1
         AND pds.service_id = $2
         AND pds.disabled_at IS NULL
         AND pd.is_active = TRUE`,
      [req.user.id, service_id]
    );

    const filtered = endpoint ? rows.filter((row) => row.endpoint === endpoint) : rows;
    if (!filtered.length) {
      return res.status(404).json({ error: 'No active subscriptions found' });
    }

    const payload = {
      title: 'Notification Hub Test',
      body: 'Push notifications are working ✅',
      url: '/done',
      tag: 'test'
    };

    const results = await Promise.all(
      filtered.map((row) =>
        sendPush({
          subscription: {
            endpoint: row.endpoint,
            keys: {
              p256dh: row.p256dh,
              auth: row.auth
            }
          },
          payload,
          deviceId: row.device_id
        })
      )
    );

    return res.json({ success: true, results });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/internal/push/send', ensureApiKey, async (req, res, next) => {
  try {
    const { service_id, user_id, title, body, url, tag, urgency, topics } = req.body;
    if (!service_id || !user_id || !title || !body) {
      return res.status(400).json({ error: 'service_id, user_id, title, body are required' });
    }

    const { rows } = await query(
      `SELECT pd.id AS device_id, pd.endpoint, pd.p256dh, pd.auth, pds.topics_json
       FROM push_devices pd
       JOIN push_device_services pds ON pd.id = pds.device_id
       WHERE pd.user_id = $1
         AND pds.service_id = $2
         AND pds.disabled_at IS NULL
         AND pd.is_active = TRUE`,
      [user_id, service_id]
    );

    const topicFilter = normalizeTopics(topics);
    const eligible = rows.filter((row) => {
      if (!topicFilter.length) {
        return true;
      }
      const subscribed = Array.isArray(row.topics_json) ? row.topics_json : [];
      if (!subscribed.length) {
        return true;
      }
      return subscribed.some((topic) => topicFilter.includes(topic));
    });

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'notification',
      urgency: urgency || 'normal'
    };

    const results = await Promise.all(
      eligible.map((row) =>
        sendPush({
          subscription: {
            endpoint: row.endpoint,
            keys: {
              p256dh: row.p256dh,
              auth: row.auth
            }
          },
          payload,
          deviceId: row.device_id
        })
      )
    );

    return res.json({ success: true, delivered: eligible.length, results });
  } catch (error) {
    return next(error);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Notification Hub listening on port ${PORT}`);
});
