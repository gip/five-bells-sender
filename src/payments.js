'use strict'
const request = require('superagent')
const uuid = require('uuid4')

import {
  setupTransferConditionsAtomic,
  setupTransferConditionsUniversal,
  postTransfer
} from './transferUtils'

/**
 * @param {[Payment]} payments
 * @param {URI} sourceAccount
 * @returns {[Payment]}
 */
export function setupTransfers (payments, sourceAccount) {
  // The forEach only modifies `source_transfers` because:
  //   payment[n-1].destination_transfers == payment[n].source_transfers
  // The final transfer is updated at the end.
  payments.forEach(function (payment, i) {
    validateOneToOnePayment(payment)
    const transfer = payment.source_transfers[0]
    transfer.id = transfer.ledger + '/transfers/' + uuid()
    transfer.additional_info = {part_of_payment: payment.id}
    // Add start and endpoints in payment chain from user-provided payment object
    if (i === 0) {
      transfer.debits[0].account = sourceAccount
    } else {
      transfer.debits = payments[i - 1].destination_transfers[0].debits
      // Make sure the source and destination transfers reference the same objects,
      // so that modifications to one affect both.
      payments[i - 1].destination_transfers = [transfer]
    }
  })

  // Create final (rightmost) transfer
  const finalPayment = payments[payments.length - 1]
  const finalTransfer = finalPayment.destination_transfers[0]
  finalTransfer.id = finalTransfer.ledger + '/transfers/' + uuid()
  finalTransfer.additional_info = {part_of_payment: finalPayment.id}
  return payments
}

/**
 * @param {Payment} payment
 */
function validateOneToOnePayment (payment) {
  if (payment.source_transfers.length !== 1 ||
      payment.destination_transfers.length !== 1) {
    throw new Error('five-bells-sender only supports one-to-one payments')
  }
}

/**
 * @param {[Payment]} payments
 * @param {Object} params
 * @param {Boolean} params.isAtomic
 * @param {Condition} params.executionCondition
 * @param {Condition} params.cancellationCondition (iff isAtomic)
 * @param {URI} params.caseID (iff isAtomic)
 * @returns {[Payment]}
 */
export function setupConditions (payments, params) {
  const {isAtomic, executionCondition, cancellationCondition, caseID} = params
  const transfers = toTransfers(payments)
  const finalTransfer = transfers[transfers.length - 1]
  // Use one Date.now() as the base of all expiries so that when a ms passes
  // between when the source and destination expiries are calculated the
  // minMessageWindow isn't exceeded.
  const now = Date.now()

  // Add conditions/expirations to all transfers.
  for (let transfer of transfers) {
    if (isAtomic) {
      setupTransferConditionsAtomic(transfer, {executionCondition, cancellationCondition, caseID})
    } else {
      const isFinalTransfer = transfer === finalTransfer
      setupTransferConditionsUniversal(transfer, {executionCondition, now, isFinalTransfer})
    }
  }

  // The first transfer must be submitted by us with authorization
  // TODO: This must be a genuine authorization from the user
  transfers[0].debits[0].authorized = true
  return payments
}

/**
 * @param {[Payment]} payments
 * @returns {[Transfers]}
 */
export function toTransfers (payments) {
  return payments.map(function (payment) {
    return payment.source_transfers[0]
  }).concat([
    payments[payments.length - 1].destination_transfers[0]
  ])
}

/**
 * @param {[Payment]} payments
 * @returns {Transfer}
 */
export function toFirstTransfer (payments) {
  return payments[0].source_transfers[0]
}

/**
 * @param {[Payment]} payments
 * @returns {Transfer}
 */
export function toFinalTransfer (payments) {
  return payments[payments.length - 1].destination_transfers[0]
}

/**
 * @param {[Payment]} payments
 * @param {Transfer} transfer
 * @returns {[Payment]}
 */
function replaceTransfers (payments, updatedTransfer) {
  for (let payment of payments) {
    replaceTransferInList(payment.source_transfers, updatedTransfer)
    replaceTransferInList(payment.destination_transfers, updatedTransfer)
  }
}

function replaceTransferInList (transfers, updatedTransfer) {
  const targetID = updatedTransfer.id
  for (let i = 0; i < transfers.length; i++) {
    if (transfers[i].id === targetID) transfers[i] = updatedTransfer
  }
}

/**
 * Propose + Prepare transfers
 * @param {[Payment]} payments
 * @param {Object} params
 * @param {String} params.sourceUsername
 * @param {String} params.sourcePassword
 * @returns {Promise<[Payment]>}
 */
export async function postTransfers (payments, params) {
  const transfers = toTransfers(payments)
  // TODO Theoretically we'd need to keep track of the signed responses
  // Prepare first transfer
  const firstTransfer = transfers[0]
  firstTransfer.state = await postTransfer(firstTransfer, {
    username: params.sourceUsername,
    password: params.sourcePassword
  })

  // Propose other transfers
  // TODO can these be done in parallel?
  for (let transfer of transfers.slice(1)) {
    // TODO: Also keep copy of state signature
    // Update transfer state
    transfer.state = await postTransfer(transfer)
  }
  return payments
}

/**
 * @param {[Payment]} payments
 * @return {Promise<[Payment]>}
 */
export async function postPayments (payments) {
  for (let i = 0; i < payments.length; i++) {
    const payment = payments[i]
    const updatedDestinationTransfer = (await postPayment(payment)).destination_transfers[0]
    replaceTransfers(payments, updatedDestinationTransfer)
  }
  return payments
}

/**
 * @param {Payment} payment
 * @return {Promise<Object>} the PUT response body
 */
async function postPayment (payment) {
  const paymentRes = await request
    .put(payment.id)
    .send(payment)
  if (paymentRes.status >= 400) {
    throw new Error('Remote error: ' + paymentRes.status + ' ' +
      JSON.stringify(paymentRes.body))
  }
  return paymentRes.body
}