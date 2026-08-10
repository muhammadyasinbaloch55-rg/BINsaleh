// middleware/validate.js
// Central express-validator error handler.
// Runs after the validation chains declared on a route. On failure it
// responds 400 with the FIRST rule's message, written to match each
// controller's existing message so normal clients see identical
// responses to before the validator was added.
const { validationResult } = require('express-validator');

module.exports = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }
  next();
};
