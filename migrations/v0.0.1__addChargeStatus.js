module.exports.migrate = async ({ firestore }) => {
    await firestore.collection('dev-gifts').get()
        .then((querySnapshot) => {
            querySnapshot.docs.forEach((doc) => {
                firestore.collection('dev-gifts').doc(doc.id).update({ chargeStatus: 'paid' });
            });
        });
};
