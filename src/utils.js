// NPM Dependencies
const bech32 = require('bech32');
const _ = require('lodash');
const Mixpanel = require('mixpanel');
const crypto = require('crypto');

const mixpanel = Mixpanel.init(process.env.MIXPANEL_TOKEN);

exports.validateGiftCreation = (amount, senderName, senderMessage, notify, verifyCode) => {
    var result = {};

    if (!Number.isInteger(amount)) {
        result.statusCode = 400;
        result.err = new Error('GIFT_AMOUNT_NOT_WHOLE_NUMBER');
    } else if (amount < 100) {
        result.statusCode = 400;
        result.err = new Error('GIFT_AMOUNT_UNDER_100');
    } else if (amount > 500000) {
        result.statusCode = 400;
        result.err = new Error('GIFT_AMOUNT_OVER_500K');
    } else if (!_.isNil(senderName) && !_.isString(senderName)) {
        result.statusCode = 400;
        result.err = new Error('SENDER_NAME_NOT_STRING');
    } else if (!_.isNil(senderName) && senderName.length > 15) {
        result.statusCode = 400;
        result.err = new Error('SENDER_NAME_BAD_LENGTH');
    } else if (!_.isNil(senderMessage) && !_.isString(senderMessage)) {
        result.statusCode = 400;
        result.err = new Error('SENDER_MESSAGE_NOT_STRING');
    } else if (!_.isNil(senderMessage) && senderMessage.length > 100) {
        result.statusCode = 400;
        result.err = new Error('SENDER_MESSAGE_BAD_LENGTH');
    } else if (!_.isNil(verifyCode) && !_.isNumber(verifyCode)) {
        result.statusCode = 400;
        result.err = new Error('VERIFY_CODE_NOT_NUMBER');
    } else if (!_.isNil(verifyCode) && verifyCode.toString().length !== 4) {
        result.statusCode = 400;
        result.err = new Error('VERIFY_CODE_BAD_LENGTH');
    }

    return result;
}

exports.validateGiftRedeem = (gift, {invoice, verifyCode}) => {
    var result = {};

    let invoiceAmount = getInvoiceAmount(invoice);
    if (invoiceAmount !== gift.amount) {
        result.statusCode = 400;
        result.err = new Error('BAD_INVOICE_AMOUNT');
    } else if (gift.spent === 'pending') {
        result.statusCode = 400;
        result.err = new Error('GIFT_REDEEM_PENDING');
    } else if (gift.spent) {
        result.statusCode = 400;
        result.err = new Error('GIFT_SPENT');
    } else if (gift.chargeStatus !== 'paid') {
        result.statusCode = 400;
        result.err = new Error('GIFT_INVOICE_UNPAID');
    } else if (!_.isNil(gift.verifyCode) && Number(verifyCode) !== gift.verifyCode) {
        result.statusCode = 400;
        result.err = new Error('BAD_VERIFY_CODE');
    }

    return result;
}

const getInvoiceAmount = invoice => {
    const cleanInvoice = invoice.toLowerCase();

    let removedNetwork;
    if (_.startsWith(cleanInvoice, 'lnbc')) {
        removedNetwork = cleanInvoice.replace('lnbc', '');
    } else if (_.startsWith(cleanInvoice, 'lntb')) {
        removedNetwork = cleanInvoice.replace('lntb', '');
    } else if (_.startsWith(cleanInvoice, 'lnbcrt')) {
        removedNetwork = cleanInvoice.replace('lnbcrt', '');
    } else {
        throw 'Not a BOLT-11 invoice';
    }

    const multiplier = removedNetwork.match(/[a-zA-Z]/).pop();

    let invoiceAmount;
    if (multiplier === 'n') {
        const multiplierPosition = removedNetwork.indexOf('n');
        invoiceAmount = removedNetwork.substring(0, multiplierPosition - 1);
    } else if (multiplier === 'u') {
        const multiplierPosition = removedNetwork.indexOf('u');
        invoiceAmount = removedNetwork.substring(0, multiplierPosition);
        invoiceAmount += '00';
    } else if (multiplier === 'm') {
        const multiplierPosition = removedNetwork.indexOf('m');
        invoiceAmount = removedNetwork.substring(0, multiplierPosition);
        invoiceAmount += '00000';
    } else {
        throw new Error('Something went wrong with BOLT-11 decoding');
    }

    const amountAsNumber = Number(invoiceAmount);
    return amountAsNumber;
};

exports.buildLNURL = (orderId, verifyCode = null) => {
    let pin = verifyCode ? `?verifyCode=${verifyCode}` : '';

    return bech32.encode(
        'lnurl',
        bech32.toWords(Buffer.from(
            `${process.env.SERVICE_URL}/lnurl/${orderId}${pin}`
        )),
        1500
    );
}

exports.trackEvent = (req, eventName, params) => {
    const ip = process.env.NODE_ENV === 'production' ? req.ip : req.headers["x-forwarded-for"];
    const id = crypto.createHash('md5').update(_.toString(ip)).digest("hex");
    const route = req.baseUrl || req.path;

    mixpanel.track(eventName, {
        distinct_id: id,
        ip,
        route,
        userIp: ip,
        ...params
    });
};
