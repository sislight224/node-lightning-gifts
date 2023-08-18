// NPM Dependencies
const express = require('express');
const cryptoRandomString = require('crypto-random-string');
const rateLimit = require('express-rate-limit');
const _ = require('lodash');
const Sentry = require('@sentry/node');

// Module Dependencies
const {
    createInvoice,
    getInvoiceStatus,
    redeemGift,
    checkRedeemStatus
} = require('./controllers');
const {
    getGiftInfo,
    createGift,
    giftWithdrawSuccess,
    giftWithdrawFail,
    updateGiftChargeStatus
} = require('./models');
const {
    buildLNURL,
    trackEvent,
    validateGiftCreation,
    validateGiftRedeem
} = require('./utils');

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50
});

const checkLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200
});

const app = express();

if (process.env.NODE_ENV === 'production') {
    app.enable('trust proxy');
    Sentry.init({ dsn: process.env.SENTRY_KEY });
    app.use(Sentry.Handlers.requestHandler());
}

app.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/create', apiLimiter, (req, res, next) => {
    const { amount, senderName = null, senderMessage = null, notify = null, verifyCode = null } = req.body;
    const giftId = cryptoRandomString({ length: 48 });

    const { err, statusCode } = validateGiftCreation(amount, senderName, senderMessage, notify, verifyCode)
    if (err) {
        res.statusCode = statusCode;
        next(err);
    } else {
        createInvoice({ giftId, amount })
            .then(({ id, settled, payment_request, num_satoshis }) => {
                const chargeId = id;
                const amount = num_satoshis;
                const status = settled === 0 ? 'unpaid' : 'paid';

                createGift({
                    giftId,
                    amount,
                    chargeId,
                    chargeStatus: status,
                    chargeInvoice: payment_request,
                    notify,
                    senderName,
                    senderMessage,
                    verifyCode
                });

                trackEvent(req, 'create try', { giftId });

                res.json({
                    orderId: giftId,
                    chargeId,
                    status,
                    lightningInvoice: { payreq: payment_request },
                    amount,
                    notify,
                    lnurl: buildLNURL(giftId, verifyCode),
                    senderName,
                    senderMessage
                });
            })
            .catch(next);
    }
});

app.get('/lnurl', apiLimiter, (req, res, next) => {
    const { amount: msatoshi, senderName = null, senderMessage = null, notify = null, verifyCode = null } = req.query;

    const metadata = JSON.stringify([
        ['text/plain', 'Create a Lightning Gift' +
            (senderName ? ` from "${senderName}"` : '') +
            (senderMessage ? ` with message "${senderMessage}"` : '') +
            (verifyCode ? ` secured by code "${verifyCode}"` : '') +
            (notify ? ` that will post a webhook to "${notify}" when redeemed` : '') +
            '.'
        ],
        ['image/png;base64', require('./logo.js')]
    ])

    if (!msatoshi) {
        // first lnurl-pay call, just return the parameters
        let params = new URLSearchParams();
        if (senderName) params.set('senderName', senderName);
        if (senderMessage) params.set('senderMessage', senderMessage);
        if (notify) params.set('notify', notify);
        if (verifyCode) params.set('verifyCode', verifyCode);
        let qs = params.toString();

        res.json({
            minSendable: 100000,
            maxSendable: 500000000,
            tag: 'payRequest',
            metadata,
            callback: `${process.env.SERVICE_URL}/lnurl${qs ? '?' + qs : ''}`
        });
    } else {
        // second lnurl-pay call, actually create a gift and return the payment request
        const giftId = cryptoRandomString({ length: 48 });

        const { err, statusCode } = validateGiftCreation(msatoshi / 1000, senderName, senderMessage, notify, verifyCode)
        if (err) {
            res.statusCode = statusCode;
            next(err);
        } else {
            createInvoice({ giftId, amount: msatoshi / 1000, metadata })
                .then(({ id, settled, payment_request, num_satoshis }) => {
                    const chargeId = id;
                    const amount = num_satoshis;
                    const status = settled === 0 ? 'unpaid' : 'paid';

                    createGift({
                        giftId,
                        amount,
                        chargeId,
                        chargeStatus: status,
                        chargeInvoice: payment_request,
                        notify,
                        senderName,
                        senderMessage,
                        verifyCode
                    });

                    trackEvent(req, 'lnurl create try', { giftId });

                    res.json({
                        pr: payment_request,
                        successAction: {
                            tag: 'url',
                            description: "Here's your gift URL",
                            url: `${process.env.SERVICE_URL}/view/${giftId}`
                        },
                        disposable: false,
                        routes: []
                    });
                })
                .catch(next);
        }
    }
});

app.post(`/webhook/${process.env.LNPAY_WALLET}`, (req, res, next) => {
    const { event, data: {wtx} } = req.body;

    if (wtx.wal.id !== process.env.LNPAY_WALLET) {
        res.sendStatus(200);
        return
    }

    const { giftId } = wtx.passThru

    switch (event.name) {
        case 'wallet_receive':
            // a gift was paid
            try {
                updateGiftChargeStatus({ giftId, chargeStatus: 'paid' })

                trackEvent(req, 'create success', { giftId, amount: wtx.lnTx.num_satoshis });
            } catch (error) {
                next(error);
                return
            }

            break
        case 'wallet_send':
            // a gift was redeemed
            const status = wtx.lnTx.settled === 1 ? 'confirmed' : 'failed';
            const withdrawalId = wtx.lnTx.id;
            const amount = wtx.lnTx.num_satoshis;
            const fee = 0;

            if (status === 'confirmed') {
                try {
                    giftWithdrawSuccess({ giftId, withdrawalId, fee });
                    trackEvent(req, 'redeem success', { giftId, amount });
                } catch (error) {
                    next(error);
                    return
                }
            } else if (status === 'failed') {
                try {
                    giftWithdrawFail({ giftId });
                } catch (error) {
                    next(error);
                    return
                }
            }

            break
    }

    res.sendStatus(200);
});

app.get('/status/:chargeId', checkLimiter, (req, res, next) => {
    const { chargeId } = req.params;

    if (_.isNil(chargeId)) {
        res.statusCode = 404;
        next(new Error('NO_CHARGE_ID'));
    }

    trackEvent(req, 'charge query', { chargeId });

    try {
        getInvoiceStatus(chargeId)
            .then(status => {
                res.json({ status });
            })
            .catch(error => {
                next(error);
            });
    } catch (error) {
        next(error);
    }
});

app.get('/view/:giftId', apiLimiter, (req, res, next) => {
    let { giftId } = req.params;
    let base = process.env.SERVICE_URL.replace(/\/\/[^\.]+\./, '//');
    res.redirect(`${base}/redeem/${giftId}`);
})

app.get('/gift/:giftId', checkLimiter, (req, res, next) => {
    const { giftId } = req.params;
    const { verifyCode: verifyCodeTry = null } = req.query;

    if (_.isNil(giftId)) {
        res.statusCode = 404;
        next(new Error('NO_GIFT_ID'));
    }

    trackEvent(req, 'gift query', { giftId });

    try {
        getGiftInfo(giftId).then(response => {
            if (_.isNil(response)) {
                res.statusCode = 404;
                next(new Error('GIFT_NOT_FOUND'));
            } else {
                const { amount, spent, chargeStatus, verifyCode } = response;

                if (!_.isNil(verifyCode) && Number(verifyCodeTry) !== verifyCode) {
                    res.json({
                        amount,
                        chargeStatus,
                        spent,
                        orderId: giftId,
                        verifyCodeRequired: true
                    });
                } else {
                    res.json({ ...response, orderId: giftId, lnurl: buildLNURL(giftId) });
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post('/redeem/:giftId', apiLimiter, (req, res, next) => {
    const { giftId } = req.params;

    if (_.isNil(giftId)) {
        res.statusCode = 404;
        next(new Error('NO_GIFT_ID'));
    }

    getGiftInfo(giftId)
        .then(gift => {
            if (_.isNil(gift)) {
                res.statusCode = 404;
                next(new Error('GIFT_NOT_FOUND'));
            } else {
                let { err, statusCode } = validateGiftRedeem(gift, req.body)
                if (err) {
                    res.statusCode = statusCode;
                    next(err);
                } else {
                    const { invoice } = req.body;

                    redeemGift({ giftId, invoice })
                        .then(({ id: withdrawalId }) => {
                            trackEvent(req, 'invoice redeem try', { giftId });
                            res.json({ withdrawalId });
                        })
                        .catch(error => {
                            next(error);
                        });
                }
            }
        })
        .catch(error => {
            next(error);
        });
});

app.get('/lnurl/:giftId', apiLimiter, (req, res, next) => {
        const { giftId } = req.params;
        const { pr: invoice, verifyCode } = req.query;

        getGiftInfo(giftId)
            .then(gift => {
                if (_.isNil(invoice)) {
                    // if pr wasn't sent this is the first lnurl call
                    let pin = verifyCode ? `?verifyCode=${verifyCode}` : '';
                    res.json({
                        status: 'OK',
                        callback: `${process.env.SERVICE_URL}/lnurl/${giftId}${pin}`,
                        k1: giftId,
                        maxWithdrawable: gift.amount * 1000,
                        minWithdrawable: gift.amount * 1000,
                        defaultDescription: `lightning.gifts redeem ${giftId}`,
                        tag: 'withdrawRequest'
                    });
                    return
                }

                // this is the second lnurl call, so we must validate before redeem
                if (gift.createdAt._seconds < 1594588666) {
                    // up to gifts issued at 2020-07-12 we don't check verifyCode here
                    //      for backwards compatibility
                    gift.verifyCode = null;
                }
                let { err, statusCode } = validateGiftRedeem(gift, {invoice, verifyCode})
                if (err) {
                    res.statusCode = statusCode;
                    next(err);
                } else {
                    return redeemGift({ giftId, invoice })
                        .then(() => {
                            trackEvent(req, 'lnurl redeem try', { giftId });
                            res.json({ status: 'OK' });
                        })
                }
            })
            .catch(error => {
                next(error);
            });
    }
);

app.post('/redeemStatus/:withdrawalId', checkLimiter, (req, res, next) => {
    const { withdrawalId } = req.params;

    if (_.isNil(withdrawalId)) {
        res.statusCode = 404;
        next(new Error('NO_WITHDRAW_ID'));
    }

    trackEvent(req, 'redeem query', { withdrawalId });

    checkRedeemStatus(withdrawalId)
        .then(response => {
            const { reference, status } = response.data;

            res.json({ reference, status });
        })
        .catch(() => {
            next(new Error('WITHDRAWAL_FAILED'));
        });
});

if (process.env.NODE_ENV === 'production') {
    app.use(Sentry.Handlers.errorHandler());
}

// error handling
app.use((error, req, res, next) => {
    // lnurl error handling
    if (_.startsWith(req.path, '/lnurl')) {
        console.log('lnurl error:', error);
        res.status(200).send({
            status: 'ERROR',
            reason: error.message
        });
        return
    }

    const statusCode =
        _.defaultTo(_.defaultTo(error.statusCode, _.get(error, 'response.status')), _.defaultTo(res.statusCode, 500));
    // console.log('req.ip', req.ip);
    // console.log('x-forwarded-for', req.headers["x-forwarded-for"]);
    trackEvent(req, 'exception', { message: error.message });

    res.status(statusCode).send({
        statusCode,
        message: error.message
    });
});

// listen for requests :)
app.set('port', process.env.PORT || 8080);
const server = app.listen(app.get('port'), () => {
    console.log(`Your app is listening on port ${server.address().port}`);
});
