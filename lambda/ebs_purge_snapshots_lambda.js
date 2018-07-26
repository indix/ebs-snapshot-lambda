var ebs = require('./ebs');


var handler = (event, context, callback) =>
    
  ebs.purgeSnapshotsInBatches(process.env.BATCH_SIZE || 100)
  .then(()=> callback(null, 'Finished'))
  .catch(callback);


exports.handler = handler

//Uncomment below to test locally
// exports.handler(null, null, function(e, s) {
//   if(e) {
//     console.log("[ERROR] ", e);
//     return;
//   }

//   console.log(s);
// });
