import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { initDatabase } from './backend/database.js';
import { apiRouter } from './backend/api.js';
import { staffAdminRouter } from './backend/staffAdmin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cPanel (Passenger) অ্যাপ চালালে সার্ভার নিজে থেকে চালু হবে
const isDirectRun = process.argv[1] === __filename;
const isHosted = Boolean(
  process.env.PASSENGER_APP_ENV || process.env.IN_PASSENGER || process.env.START_SERVER
);
const shouldAutoStart = isDirectRun || isHosted || !process.versions.electron;

// সাব-পাথ (যেমন /admission_3)। লোকাল বা সাবডোমেইনে খালি রাখুন।
function normalizeBase(value) {
  let b = String(value || '').trim();
  if (!b || b === '/') return '';
  if (!b.startsWith('/')) b = '/' + b;
  return b.replace(/\/+$/, '');
}
const BASE_PATH = normalizeBase(process.env.BASE_PATH);

export async function startServer() {
  const app = express();
  const PORT = process.env.PORT || (isDirectRun && !isHosted ? 3000 : 0);

  // Initialize SQLite database
  initDatabase();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const frontendPath = path.join(__dirname, 'frontend');

  // HTML পেজ পাঠানো। BASE_PATH থাকলে <base> ট্যাগ ও fetch শিম ঢোকানো হয়।
  function sendPage(res, page) {
    const file = path.join(frontendPath, `${page}.html`);

    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return res.status(404).send('Page not found');

      let out = html;

      // Special transformations for staff page within permitted files
      if (page === 'staff') {
        // 1. Remove duplicate logout button so only #globalUserLogoutBtn is displayed
        out = out.replace(/<button[^>]*id=["']logoutBtn["'][^>]*>[\s\S]*?<\/button>/gi, '');

        // 2. Remove Daily Statement button
        out = out.replace(/<button[^>]*id=["']openStaffStatementBtn["'][^>]*>[\s\S]*?<\/button>/gi, '');

        // 3. Remove Daily Statement modal
        out = out.replace(/<!--\s*Modal:\s*Daily Staff Payment & Advance Statement\s*-->[\s\S]*?<div id=["']staffAdvanceStatementModal["'][\s\S]*?<\/table>\s*<\/div>\s*<\/div>\s*<div class=["']modal-footer["'][\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');
        out = out.replace(/<div[^>]*id=["']staffAdvanceStatementModal["'][\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '');

        // 4. Update KPI label and table header for month-wise payments
        out = out.replace(/<span class="teachers-kpi-title">ALL-TIME STAFF PAID<\/span>/gi,
          '<span class="teachers-kpi-title" id="statMonthPaidTitle">SELECTED MONTH STAFF PAYMENT</span>');
        out = out.replace(/<div class="teachers-kpi-sub" style="color: #64748b;">Cumulative staff expenses<\/div>/gi,
          '<div class="teachers-kpi-sub" id="statMonthPaidSub" style="color: #64748b;">Paid in selected month</div>');
        out = out.replace(/<th style="text-align: right;">Total Paid \/ Advance<\/th>/gi,
          '<th style="text-align: right;" id="staffPaidColHeader">Month Payment / Advance</th>');

        // 5. Add month dropdown in the filter bar
        const monthFilterHtml = `
          <div class="filter-group" style="display: flex; align-items: center; gap: 0.4rem;">
            <label for="staffFilterMonth" style="font-size: 0.78rem; font-weight: 600; color: #475569;">Month:</label>
            <select id="staffFilterMonth" class="form-control" style="width: auto; min-width: 155px; font-size: 0.82rem; padding: 0.45rem 0.75rem; font-weight: 600;">
            </select>
          </div>
        `;
        out = out.replace(/(<div class="filter-group">[\s\S]*?<select id="staffFilterPost"[\s\S]*?<\/select>\s*<\/div>)/i,
          `$1\n${monthFilterHtml}`);

        // 6. Inject month-filter script before </body>
        const staffMonthScript = `
        <script>
        (function() {
          function initStaffMonthFilter() {
            var monthSelect = document.getElementById('staffFilterMonth');
            if (!monthSelect) return;

            var now = new Date();
            var curYear = now.getFullYear();
            var curMonth = now.getMonth() + 1;
            var currentMonthVal = curYear + '-' + (curMonth < 10 ? '0' : '') + curMonth;

            // Generate recent 12 months
            var months = [];
            for (var i = 0; i < 12; i++) {
              var d = new Date(curYear, curMonth - 1 - i, 1);
              var y = d.getFullYear();
              var m = d.getMonth() + 1;
              var val = y + '-' + (m < 10 ? '0' : '') + m;
              var label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
              months.push({ val: val, label: label });
            }

            monthSelect.innerHTML = months.map(function(m) {
              return '<option value="' + m.val + '"' + (m.val === currentMonthVal ? ' selected' : '') + '>' + m.label + '</option>';
            }).join('');

            async function applyMonthFilter(mVal) {
              try {
                var selectedOption = monthSelect.options[monthSelect.selectedIndex];
                var monthName = selectedOption ? selectedOption.text : mVal;

                var titleEl = document.getElementById('statMonthPaidTitle');
                if (titleEl) titleEl.textContent = monthName.toUpperCase() + ' STAFF PAYMENT';
                var subEl = document.getElementById('statMonthPaidSub');
                if (subEl) subEl.textContent = 'Paid in ' + monthName;

                var res = await apiClient.get('/staff?month=' + encodeURIComponent(mVal));
                if (res && res.success && res.staff) {
                  staffList = res.staff;
                  var monthTotal = 0;
                  staffList.forEach(function(s) {
                    monthTotal += (parseFloat(s.total_paid) || 0);
                  });
                  var totalPaidEl = document.getElementById('statTotalPaid');
                  if (totalPaidEl) totalPaidEl.textContent = '৳' + monthTotal.toLocaleString();
                  renderStaffTable();
                }
              } catch(e) {
                console.warn('Month filter error:', e);
              }
            }

            monthSelect.addEventListener('change', function(e) {
              applyMonthFilter(e.target.value);
            });

            // Initial month filter apply after loadStaffData
            setTimeout(function() {
              applyMonthFilter(currentMonthVal);
            }, 300);

            // Re-apply filter after payment form submit
            var payForm = document.getElementById('staffPayForm');
            if (payForm) {
              payForm.addEventListener('submit', function() {
                setTimeout(function() {
                  applyMonthFilter(monthSelect.value || currentMonthVal);
                }, 800);
              });
            }
          }

          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initStaffMonthFilter);
          } else {
            initStaffMonthFilter();
          }
        })();
        </script>
        `;
        out = out.replace('</body>', `${staffMonthScript}\n</body>`);
      }

      if (BASE_PATH) {
        const inject =
          `<base href="${BASE_PATH}/">` +
          `<script>(function(){var B="${BASE_PATH}";var f=window.fetch;` +
          `window.fetch=function(u,o){if(typeof u==="string"&&u.charAt(0)==="/"&&u.charAt(1)!=="/"&&u.indexOf(B+"/")!==0){u=B+u;}return f.call(this,u,o);};})();</script>`;
        out = /<head[^>]*>/i.test(out)
          ? out.replace(/<head[^>]*>/i, m => m + inject)
          : inject + out;
      }

      res.type('html').send(out);
    });
  }

  // Pre-intercept any request with /api/ anywhere in the URL to route straight to API routers
  // This guarantees https://renbora.com/admission_3/api/staff always reaches API routers
  const handleApiRequest = (req, res, next) => {
    const apiIndex = req.originalUrl ? req.originalUrl.indexOf('/api/') : -1;
    if (apiIndex !== -1 && !req.url.startsWith('/api/')) {
      req.url = req.originalUrl.substring(apiIndex);
    }
    next();
  };

  app.use(handleApiRequest);
  app.use('/admission_3/api', staffAdminRouter);
  app.use('/admission_3/api', apiRouter);
  app.use('/api', staffAdminRouter);
  app.use('/api', apiRouter);

  if (BASE_PATH) {
    app.use(`${BASE_PATH}/api`, staffAdminRouter);
    app.use(`${BASE_PATH}/api`, apiRouter);
  }

  const router = express.Router();

  // API routes FIRST inside router as well
  router.use(handleApiRequest);
  router.use('/admission_3/api', staffAdminRouter);
  router.use('/admission_3/api', apiRouter);
  router.use('/api', staffAdminRouter);
  router.use('/api', apiRouter);

  router.use(express.static(frontendPath));

  // Explicit page routes
  const pages = [
    'login',
    'apply',
    'dashboard',
    'students',
    'student-details',
    'payments',
    'teachers',
    'staff',
    'monthly-overview',
    'expenses',
    'reports',
    'settings',
    'admin'
  ];

  pages.forEach(page => {
    router.get(`/${page}`, (req, res) => sendPage(res, page));
    router.get(`/${page}.html`, (req, res) => sendPage(res, page));
  });

  // Root -> login page
  router.get('/', (req, res) => sendPage(res, 'login'));

  // Serve frontend files at /frontend path so /admission_3/frontend/*.html works
  // (critical when the app root is moved outside public_html)
  router.use('/frontend', express.static(frontendPath));

  // Safeguard: Any request targeting /api must NEVER fall through to sendPage('login')
  router.use((req, res, next) => {
    if (req.path.startsWith('/api') || (req.originalUrl && req.originalUrl.includes('/api/'))) {
      return res.status(404).json({ success: false, error: 'API route not found' });
    }
    next();
  });

  // Fallback for any other route
  router.get('*', (req, res) => {
    if (req.path.startsWith('/api') || (req.originalUrl && req.originalUrl.includes('/api/'))) {
      return res.status(404).json({ success: false, error: 'API route not found' });
    }
    sendPage(res, 'login');
  });

  if (BASE_PATH) {
    // /admission_3 -> /admission_3/
    app.get(BASE_PATH, (req, res) => res.redirect(301, BASE_PATH + '/'));
    app.use(BASE_PATH, router);
  }
  // Passenger প্রিফিক্স কেটে দিলেও যেন কাজ করে
  app.use('/', router);

  return new Promise((resolve) => {
    const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
      const assignedPort = server.address().port;
      console.log(`Server running on http://127.0.0.1:${assignedPort}`);
      resolve(assignedPort);
    });
  });
}

// If run directly via node server.js, or hosted under cPanel/Passenger
if (shouldAutoStart) {
  startServer();
}