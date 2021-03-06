'use strict'

const Validator = require('five-bells-shared').Validator
const InvalidBodyError = require('five-bells-shared').InvalidBodyError

const validator = new Validator()

validator.loadSharedSchemas()

function validate (schema, json) {
  const validatorResult = validator.create(schema)(json)
  if (!validatorResult.valid) {
    throw new InvalidBodyError(schema + ' schema validation error: ' + validatorResult.errors[0].message)
  }
}

exports.validateTransfer = function (transfer) { validate('Transfer', transfer) }
