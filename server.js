import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { initDatabase } from './backend/database.js';
import { apiRouter } from './backend/api.js';
import { staffAdminRouter } from './backend/staffAdmin.js';

export async function startServer() {
  const app = express();
  const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
  const PORT = process.env.PORT || (isDirectRun ? 3000 : 0);

  // Initialize SQLite database
  initDatabase();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API routes FIRST (Supabase staff/admin routes before the general API router)
  app.use('/api', staffAdminRouter);
  app.use('/api', apiRouter);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const frontendPath = path.join(__dirname, 'frontend');
  app.use(express.static(frontendPath));

  // Explicit page routes
  const pages = [
    'login',
    'apply',
    'dashboard',
    'students',
    'student-details',
    'payments',
    'teachers',
    'monthly-overview',
    'expenses',
    'reports',
    'settings',
    'admin'
  ];

  pages.forEach(page => {
    app.get(`/${page}`, (req, res) => {
      res.sendFile(path.join(frontendPath, `${page}.html`));
    });
    app.get(`/${page}.html`, (req, res) => {
      res.sendFile(path.join(frontendPath, `${page}.html`));
    });
  });

  // Root -> login page
  app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
  });

  // Fallback for any other route
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'login.html'));
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
      const assignedPort = server.address().port;
      console.log(`Server running on http://127.0.0.1:${assignedPort}`);
      resolve(assignedPort);
    });
  });
}

// If run directly via node server.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}