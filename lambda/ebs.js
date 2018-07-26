var utils = require('./utils');

var AWS = require('aws-sdk');
var ec2 = new AWS.EC2(utils.getRegionObject());
var config = require('./config.json');
var promisesToPurgeSnapshotsInBatches = []

var getPurgeDate = function(tags) {
  var purgeDate = new Date();
  purgeDate.setTime(purgeDate.getTime() + (tags['Retention'] || config.defaultRetention) * 86400000 );
  
  return utils.getDate(purgeDate);
};

var createSnapshot = function(volumeId) {
  var snapshotParams = {
    VolumeId: volumeId,
    DryRun: false
  };
  
  return ec2.createSnapshot(snapshotParams).promise();
};

var tagSnapshot = function(volume, snapshotId) {
  var tags = utils.getTags(volume.Tags);
  var purgeDate = getPurgeDate(tags);
  var additionalTags = [];
  if(config.copyVolumeTagsToSnapshot) {
    additionalTags = volume.Tags.filter(function(tag) {
      return tag.Key !== "Retention" && tag.Key !== "Snapshot";
    })
  }

  var snapshotTagParams = {
    Resources: [snapshotId],
    Tags: [
      {
        Key: 'VolumeId',
        Value: volume.VolumeId
      },
      {
        Key: 'PurgeDate',
        Value: purgeDate
      },
    ].concat(additionalTags),
    DryRun: false
  };
  
  return ec2.createTags(snapshotTagParams).promise();
}

var snapshotVolumes = function () {
  var getVolumesParam = {
    DryRun: false,
    Filters: [
      {
        Name: "tag-key",
        Values: [
          "Snapshot"
        ]
      },
    ]
  };
  
  return ec2.describeVolumes(getVolumesParam)
    .promise()
    .then(data => Promise.all(
      data.Volumes.map(volume =>
        createSnapshot(volume.VolumeId)
          .then(data => tagSnapshot(volume, data.SnapshotId))
      )
    ));

};

var deleteSnapshot = function(SnapshotId) {
  var params = {
    SnapshotId,
    DryRun: false
  };

  console.log(">>> Deleting "+ SnapshotId + " ...");
  return ec2.deleteSnapshot(params).promise()
    .catch(err => {
      if (err.statusCode == 400 && err.code == 'InvalidSnapshot.InUse') {
        console.log(">>> Skipping ERROR on deleting "+ SnapshotId +" in use ...");
        return Promise.resolve({});
      }
      return Promise.reject();
    });
};

var checkSnapshotPurgeStatus = function(snapshot) {

  if (!snapshot.State || snapshot.State == 'completed')   // Empty-response OR snapshot-delete-status obj considered successful here.
    return Promise.resolve();

  console.log('>>> ' + snapshot.SnapshotId + ' purge state is ' + snapshot.state + '. Retrying purge once more ...');
  return retryDeleteSnapshot(snapshot.SnapshotId);
};

var retryDeleteSnapshot = deleteSnapshot;

var getSnapshots = function(MaxResults, NextToken) {
  return ec2.describeSnapshots({
    DryRun: false,
    Filters: [
      {
        Name: "tag:PurgeDate",
        Values: [process.argv[2] || utils.getDate(new Date())]
      }
    ],
    // MaxResults,  //--
    // NextToken,   //-- This pagination is not working
  }).promise();
};

var purgeSnapshots = (MaxResults, NextToken) => getSnapshots(MaxResults, NextToken)
  .then(data => Promise.all(

      data.Snapshots.map(snapshot => deleteSnapshot(snapshot.SnapshotId)
        .then(checkSnapshotPurgeStatus, err => retryDeleteSnapshot(snapshot.SnapshotId))
      )

    ).then(() => Promise.resolve(

      (data.Snapshots && data.Snapshots.length)   // If there are more snapshots
      ? data.NextToken                            // PASS NextToken
      : null                                      // Else signal a NULL

    ))

  );

var purgeSnapshotsInBatches = function(BATCH_SIZE, next) {

  return purgeSnapshots(BATCH_SIZE, next)
    .then(function(nextToken) {
      if (nextToken)
        return promisesToPurgeSnapshotsInBatches.push(purgeSnapshotsInBatches(BATCH_SIZE, nextToken));

      console.log('>>> Purge snapshot activity for '+ (process.argv[2] || utils.getDate(new Date())) +' completed in '+ (promisesToPurgeSnapshotsInBatches.length + 1) +' batches.');
      return Promise.all(promisesToPurgeSnapshotsInBatches);
    });
};

exports.snapshotVolumes = snapshotVolumes;
exports.purgeSnapshots = purgeSnapshots;
exports.purgeSnapshotsInBatches = purgeSnapshotsInBatches;