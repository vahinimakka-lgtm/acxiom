function flash(req, type, message) {
  if (!req.session) {
    return;
  }

  if (!req.session.flash) {
    req.session.flash = [];
  }

  req.session.flash.push({ type, message });
}

function attachFlash(req, res, next) {
  const messages = req.session.flash || [];
  req.session.flash = [];
  res.locals.flash = messages;
  next();
}

module.exports = {
  flash,
  attachFlash,
};
