require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const morgan = require('morgan');
const methodOverride = require('method-override');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');

const { initDb } = require('./src/db');
const { loadCurrentUser, attachAccessHelpers, requireAuthentication } = require('./src/auth');
const { attachFlash, flash } = require('./src/flash');

const authRoutes = require('./src/routes/auth');
const dashboardRoutes = require('./src/routes/dashboard');
const customerRoutes = require('./src/routes/customers');
const leadRoutes = require('./src/routes/leads');
const opportunityRoutes = require('./src/routes/opportunities');
const followupRoutes = require('./src/routes/followups');
const activityRoutes = require('./src/routes/activities');
const adminRoutes = require('./src/routes/admin');
const reportRoutes = require('./src/routes/reports');
const apiRoutes = require('./src/routes/api');

async function main() {
  await initDb();

  const app = express();
  const port = process.env.PORT || 3000;
  const csrfProtection = csrf();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({
    contentSecurityPolicy: false,
  }));
  app.use(morgan('dev'));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(methodOverride('_method'));
  app.use(cookieParser());
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite3', dir: path.join(__dirname, 'data') }),
    secret: process.env.SESSION_SECRET || 'acxiom-development-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
    },
  }));

  app.use(attachFlash);
  app.use(loadCurrentUser);
  app.use(attachAccessHelpers);
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }

    return csrfProtection(req, res, next);
  });

  app.use((req, res, next) => {
    res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
    res.locals.currentPath = req.path;
    next();
  });

  app.get('/', (req, res) => {
    if (req.user) {
      return res.redirect('/dashboard');
    }

    return res.redirect('/login');
  });

  app.use(authRoutes);
  app.use('/dashboard', requireAuthentication, dashboardRoutes);
  app.use('/customers', requireAuthentication, customerRoutes);
  app.use('/leads', requireAuthentication, leadRoutes);
  app.use('/opportunities', requireAuthentication, opportunityRoutes);
  app.use('/followups', requireAuthentication, followupRoutes);
  app.use('/activities', requireAuthentication, activityRoutes);
  app.use('/admin', requireAuthentication, adminRoutes);
  app.use('/reports', requireAuthentication, reportRoutes);
  app.use('/api', apiRoutes);

  app.use((req, res) => {
    res.status(404).render('errors/404', {
      title: 'Not Found',
    });
  });

  app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
      flash(req, 'error', 'Your form session expired. Please try again.');
      return res.redirect('back');
    }

    console.error(err);
    res.status(500).render('errors/500', {
      title: 'Server Error',
      error: process.env.NODE_ENV === 'production' ? null : err,
    });
  });

  app.listen(port, () => {
    console.log(`AxiomCRM running on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
