// NPM Dependencies
const axios = require('axios');
const shajs = require('sha.js');

const { giftWithdrawTry } = require('./models');

const lnpay = axios.create({
    baseURL: `https://api.lnpay.co/v1/wallet/${process.env.LNPAY_WALLET_KEY}`,
    timeout: 20000,
    headers: {
        'X-Api-Key': process.env.LNPAY_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

const getLnTx = id => axios.get(`https://api.lnpay.co/v1/lntx/${id}`, {
    headers: {
        'X-Api-Key': process.env.LNPAY_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
})

function lnpayError (error) {
    if (error.response && error.response.data.status) {
      error.message = `LNPay.co error ${error.response.data.status}: ${error.response.data.message}`;
    }

    error.message = 'LNPay.co error: ' + error.message;

    throw error;
}

exports.createInvoice = ({ giftId, amount, metadata }) => {
    const description = metadata
        ? undefined
        : `Lightning Gift for ${amount} sats`;

    const descriptionHash = metadata
        ? shajs('sha256').update(metadata).digest('hex')
        : undefined;

    return lnpay.post('/invoice', {
        passThru: { giftId },
        num_satoshis: amount,
        memo: description,
        description_hash: descriptionHash
    })
        .then(r => r.data)
        .catch(lnpayError);
};

exports.getInvoiceStatus = chargeId => {
    return getLnTx(chargeId)
        .then(r => r.data)
        .then(lntx => lntx.settled === 0 ? 'unpaid' : 'paid')
        .catch(lnpayError);
};

exports.redeemGift = ({ giftId, invoice }) => {
    giftWithdrawTry({
        giftId,
        reference: invoice
    });

    return lnpay.post('/withdraw', {
        passThru: { giftId },
        payment_request: invoice
    })
        .then(r => r.data)
        .then(data => data.lnTx)
        .catch(lnpayError);
};

exports.checkRedeemStatus = withdrawalId => {
    return lnpay.get(`/withdrawal/${withdrawalId}`)
        .then(r => r.data)
        .catch(lnpayError);
};
