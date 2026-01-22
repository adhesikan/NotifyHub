const app = document.getElementById('app');

const state = {
  user: null,
  services: [],
  selectedServiceId: null,
  vapidPublicKey: '',
  deferredPrompt: null,
  error: ''
};

const TOPICS_LABELS = {
  trade_alerts: 'Trade Alerts',
  fills: 'Fills',
  risk_events: 'Risk Events',
  system: 'System Updates'
};

const setState = (patch) => {
  Object.assign(state, patch);
  render();
};

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  return res.json();
};

const navigate = (path) => {
  window.history.pushState({}, '', path);
  render();
};

const setSelectedService = (serviceId) => {
  state.selectedServiceId = serviceId;
  localStorage.setItem('selectedServiceId', serviceId);
};

const loadSession = async () => {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    const servicesResponse = await api('/api/me/services');
    state.services = servicesResponse.services || [];
  } catch (error) {
    state.user = null;
    state.services = [];
  }

  state.selectedServiceId = localStorage.getItem('selectedServiceId');
};

const loadConfig = async () => {
  const config = await api('/api/config');
  state.vapidPublicKey = config.vapidPublicKey || '';
};

const serviceById = (id) => state.services.find((service) => service.id === id);

const createHeader = () => `
  <header>
    <div>
      <h1>Notification Hub</h1>
      <p>Unified push alerts across all of your services.</p>
    </div>
    ${state.user ? `<div>${state.user.email}</div>` : ''}
  </header>
`;

const renderError = (message) => {
  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>Unable to load the app</h2>
      <p>${message}</p>
      <p class="error">Check your Railway logs and environment variables, then refresh.</p>
    </div>
  `;
};

const renderLogin = () => {
  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>Log in</h2>
      <p>Use the dev login to access your Notification Hub account.</p>
      <label>
        Email address
        <input id="email" type="email" placeholder="you@company.com" />
      </label>
      <button class="btn" id="login">Send magic link (dev)</button>
      <div class="error" id="login-error"></div>
      ${state.error ? `<p class="error">${state.error}</p>` : ''}
    </div>
  `;

  document.getElementById('login').addEventListener('click', async () => {
    const email = document.getElementById('email').value.trim();
    if (!email) {
      document.getElementById('login-error').textContent = 'Enter an email to continue.';
      return;
    }
    try {
      await api('/api/dev/login', {
        method: 'POST',
        body: JSON.stringify({ email })
      });
      await bootstrap();
      proceedAfterServices();
    } catch (error) {
      document.getElementById('login-error').textContent = error.message;
    }
  });
};

const renderNoServices = () => {
  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>No eligible services found</h2>
      <p>Open your product dashboard and click <strong>Enable Push Alerts</strong>.</p>
      <p>For development, you can enter a service id to grant access.</p>
      <label>
        Enter Access Code (service id)
        <input id="service-id" placeholder="algopilotx" />
      </label>
      <button class="btn btn-secondary" id="grant">Grant Access</button>
      <div class="error" id="grant-error"></div>
    </div>
  `;

  document.getElementById('grant').addEventListener('click', async () => {
    const serviceId = document.getElementById('service-id').value.trim();
    if (!serviceId) {
      document.getElementById('grant-error').textContent = 'Enter a service id.';
      return;
    }
    try {
      await api('/api/dev/grant-access', {
        method: 'POST',
        body: JSON.stringify({ email: state.user.email, service_id: serviceId })
      });
      await bootstrap();
      proceedAfterServices();
    } catch (error) {
      document.getElementById('grant-error').textContent = error.message;
    }
  });
};

const renderServiceSelector = () => {
  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>Select a service</h2>
      <p>Choose which service should send notifications to this device.</p>
      <div class="grid">
        ${state.services
          .map(
            (service) => `
          <div class="tile" data-id="${service.id}">
            <strong>${service.name}</strong>
            <p>${service.domain_hint || ''}</p>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;

  document.querySelectorAll('.tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      setSelectedService(tile.dataset.id);
      navigate('/enable');
    });
  });
};

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const renderEnable = async () => {
  const service = serviceById(state.selectedServiceId);
  if (!service) {
    navigate('/setup');
    return;
  }

  const showInstallInstructions = isIos() && !isStandalone();

  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>Enable notifications</h2>
      <p>Service: <strong>${service.name}</strong></p>
      ${showInstallInstructions ? `
        <div class="status warning">Install required on iOS Safari</div>
        <p>Add this app to your Home Screen to enable push notifications.</p>
        <ol>
          <li>Tap the Share icon in Safari.</li>
          <li>Select <strong>Add to Home Screen</strong>.</li>
          <li>Open the installed app and return here.</li>
        </ol>
      ` : ''}
      <div class="card" style="margin-top: 16px;">
        <h3>Topics</h3>
        <p>Select which alerts you want to receive.</p>
        ${service.topics
          .map(
            (topic) => `
          <div class="topic">
            <span>${TOPICS_LABELS[topic] || topic}</span>
            <input type="checkbox" data-topic="${topic}" checked />
          </div>
        `
          )
          .join('')}
      </div>
      <button class="btn" id="enable" ${showInstallInstructions ? 'disabled' : ''}>
        Enable Notifications
      </button>
      <div class="error" id="enable-error"></div>
      <div id="install-section"></div>
    </div>
  `;

  const enableButton = document.getElementById('enable');

  enableButton.addEventListener('click', async () => {
    enableButton.disabled = true;
    document.getElementById('enable-error').textContent = '';
    try {
      if (!('serviceWorker' in navigator)) {
        throw new Error('Service workers are not supported in this browser.');
      }
      if (!state.vapidPublicKey) {
        throw new Error('Missing VAPID public key. Configure VAPID keys on the server.');
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notification permission not granted.');
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey)
      });

      const selectedTopics = Array.from(document.querySelectorAll('[data-topic]'))
        .filter((input) => input.checked)
        .map((input) => input.dataset.topic);

      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          service_id: service.id,
          subscription,
          topics: selectedTopics
        })
      });

      navigate('/done');
    } catch (error) {
      document.getElementById('enable-error').textContent = error.message;
      enableButton.disabled = false;
    }
  });

  renderInstallPrompt();
};

const renderDone = async () => {
  const service = serviceById(state.selectedServiceId);
  if (!service) {
    navigate('/setup');
    return;
  }

  if (!('serviceWorker' in navigator)) {
    app.innerHTML = `\n      ${createHeader()}\n      <div class=\"card\">\n        <h2>Push status</h2>\n        <p>This browser does not support service workers.</p>\n      </div>\n    `;\n    return;\n  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  const isEnabled = !!subscription;

  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>Push status</h2>
      <p>Service: <strong>${service.name}</strong></p>
      <div class="status ${isEnabled ? 'success' : 'warning'}">
        ${isEnabled ? 'Push Enabled ✅' : 'Push Disabled'}
      </div>
      <div style="margin-top: 16px; display: flex; gap: 12px; flex-wrap: wrap;">
        <button class="btn" id="test" ${isEnabled ? '' : 'disabled'}>Send Test Notification</button>
        <button class="btn btn-danger" id="disable" ${isEnabled ? '' : 'disabled'}>Disable</button>
      </div>
      <div class="error" id="done-error"></div>
    </div>
  `;

  document.getElementById('test').addEventListener('click', async () => {
    try {
      await api('/api/push/test', {
        method: 'POST',
        body: JSON.stringify({
          service_id: service.id,
          endpoint: subscription?.endpoint
        })
      });
    } catch (error) {
      document.getElementById('done-error').textContent = error.message;
    }
  });

  document.getElementById('disable').addEventListener('click', async () => {
    try {
      if (subscription) {
        await api('/api/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({
            service_id: service.id,
            endpoint: subscription.endpoint
          })
        });
        await subscription.unsubscribe();
      }
      navigate('/enable');
    } catch (error) {
      document.getElementById('done-error').textContent = error.message;
    }
  });
};

const renderLinking = () => {
  app.innerHTML = `
    ${createHeader()}
    <div class="card">
      <h2>Connecting...</h2>
      <p>Signing you in with your secure link.</p>
    </div>
  `;
};

const renderInstallPrompt = () => {
  const section = document.getElementById('install-section');
  if (!section) return;
  if (!state.deferredPrompt) {
    section.innerHTML = '';
    return;
  }

  section.innerHTML = `
    <button class="btn btn-secondary" id="install">Install App</button>
  `;
  document.getElementById('install').addEventListener('click', async () => {
    state.deferredPrompt.prompt();
    await state.deferredPrompt.userChoice;
    state.deferredPrompt = null;
    renderInstallPrompt();
  });
};

const proceedAfterServices = () => {
  if (!state.services.length) {
    navigate('/');
    return;
  }
  if (state.services.length === 1) {
    setSelectedService(state.services[0].id);
    navigate('/enable');
    return;
  }
  navigate('/setup');
};

const handleLinkExchange = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  if (!token) {
    navigate('/');
    return;
  }

  renderLinking();
  try {
    await api('/api/link/exchange', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
    await bootstrap();
    proceedAfterServices();
  } catch (error) {
    setState({ error: error.message });
    navigate('/');
  }
};

const render = async () => {
  const path = window.location.pathname;
  if (!state.user) {
    if (path === '/link') {
      return handleLinkExchange();
    }
    return renderLogin();
  }

  if (!state.services.length) {
    return renderNoServices();
  }

  if (path === '/setup') {
    return renderServiceSelector();
  }
  if (path === '/enable') {
    return renderEnable();
  }
  if (path === '/done') {
    return renderDone();
  }

  proceedAfterServices();
};

const bootstrap = async () => {
  await loadSession();
  await loadConfig();
};

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
};

window.addEventListener('popstate', render);
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.deferredPrompt = event;
  renderInstallPrompt();
});

bootstrap()
  .then(render)
  .catch((error) => {
    const message = error?.message || 'An unexpected error occurred.';
    setState({ error: message });
    renderError(message);
  });
