var utils = require('./utils');

var Promise = require('bluebird');
var AWS = require('aws-sdk');
var ec2 = new AWS.EC2(utils.getRegionObject());
var config = require('./config.json');

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
  
  var snapshotPromises = ec2.describeVolumes(getVolumesParam)
    .promise()
    .then(function(data) {
      return data.Volumes.map(function(volume) {
        return createSnapshot(volume.VolumeId)
          .then(function(data) {
            return tagSnapshot(volume, data.SnapshotId);
          })
      });
    });
    
    return Promise.all(snapshotPromises);
};

var deleteSnapshot = function(snapshotId) {
  var params = {
    SnapshotId: snapshotId,
    DryRun: false
  };
  return ec2.deleteSnapshot(params).promise();
};
var retryDeleteSnapshot = deleteSnapshot;

var getSnapshots = function(MaxResults, NextToken) {
  var today = utils.getDate(new Date());

  return ec2.describeSnapshots({
    DryRun: false,
    Filters: [
      {
        Name: "tag:PurgeDate",
        Values: [today]
      }
    ],
    MaxResults,
    NextToken,
  }).promise();
};

var purgeSnapshots = function(MaxResults, NextToken) {
  var nextToken;

  var snapshotDeletePromises = getSnapshots(MaxResults, NextToken)
    .then(function(data) {

      nextToken = data.NextToken;

      return data.Snapshots.map(function(snapshot) {
        return deleteSnapshot(snapshot.SnapshotId)
          .then(checkSnapshotPurgeStatus, function() { return retryDeleteSnapshot(snapshot.SnapshotId); });
      });
    });
    
  return Promise.all(snapshotDeletePromises).then(function() {
    return Promise.resolve(nextToken);
  });
};

var checkSnapshotPurgeStatus = function(snapshot) {
  if (snapshot.State == 'completed')
    return Promise.resolve();

  console.log('>>> ' + snapshot.SnapshotId + ' purge state is ' + snapshot.state + '. Retrying purge once more ...');
  return retryDeleteSnapshot(snapshot.SnapshotId);
};

var promisesToPurgeSnapshotsInBatches = []
var purgeSnapshotsInBatches = function(BATCH_SIZE, next) {
  return purgeSnapshots(BATCH_SIZE)
    .then(function(nextToken) {
      if (nextToken)
        return promisesToPurgeSnapshotsInBatches.push(purgeSnapshotsInBatches(BATCH_SIZE, next));

      console.log('>>> Purge snapshot activity completed in '+ (promisesToPurgeSnapshotsInBatches.length + 1) +' batches.');
      return Promise.all(promisesToPurgeSnapshotsInBatches);
    });
};

exports.snapshotVolumes = snapshotVolumes;
exports.purgeSnapshots = purgeSnapshots;
exports.purgeSnapshotsInBatches = purgeSnapshotsInBatches;