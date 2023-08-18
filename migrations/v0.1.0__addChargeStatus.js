module.exports.migrate = async ({ firestore }) => {
    await firestore.collection('prod-gifts').get()
        .then((querySnapshot) => {
            querySnapshot.docs.forEach((doc) => {
                firestore.collection('prod-gifts').doc(doc.id).update({ chargeStatus: 'paid' });
            });
        });
};
