// Copyright (c) 2011 Moxie Marlinspike <moxie@thoughtcrime.org>
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation; either version 3 of the
// License, or (at your option) any later version.

// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA 02111-1307
// USA


/**
  * This ChromeWorker is responsible for two things:
  *
  * 1) Listening to the ListenSocket FD for incoming connection requests,
  * which it then hands off to its parent.
  *
  * 2) Shuffling data between pairs of established SSL connections,
  * effectively moving data across the MITM bridge.
  *
  * It is setup by the ConnectionManager in components.
  *
  **/

importScripts(
  'chrome://escape/content/Logger.js',
  'chrome://escape/content/ctypes/NSPR.js',
  'chrome://escape/content/ctypes/NSS.js',
  'chrome://escape/content/ctypes/SSL.js',
  'chrome://escape/content/sockets/ServerSocket.js',
  'chrome://escape/content/sockets/ListenSocket.js',
  'chrome://escape/content/ctypes/Serialization.js',
  'chrome://escape/content/workers/ShuffleWorkerItem.js' );

var TYPE_INITIALIZE = 1;
var TYPE_CONNECTION = 2;

function ShuffleWorker() {
  this.wakeup = null;
  this.connectionPairs = [];
}

ShuffleWorker.prototype.initializeDescriptors = function() {
  var descriptors = {};
  var connectionsLength = this.connectionPairs.length * 2;
  var pollfds_t = ctypes.ArrayType(NSPR.types.PRPollDesc);
  var pollfds = new pollfds_t(connectionsLength + 2);

  for (var i=0;i<this.connectionPairs.length;i++) {
    this.connectionPairs[i].getPollDesc(
      pollfds[i*2].address(), pollfds[(i*2)+1].address() );
  }

  pollfds[connectionsLength].fd = this.wakeup;
  pollfds[connectionsLength].in_flags = NSPR.lib.PR_POLL_READ;
  pollfds[connectionsLength].out_flags = 0;

  pollfds[connectionsLength + 1].fd = this.listenSocket.fd;
  pollfds[connectionsLength + 1].in_flags = NSPR.lib.PR_POLL_READ;
  pollfds[connectionsLength + 1].out_flags = 0;

  descriptors.pollfds = pollfds;
  descriptors.connectionsLength = connectionsLength;

  return descriptors;
};

ShuffleWorker.prototype.initialize = function(data) {
  if (typeof data.logging === 'boolean') CV9BLog.print_all = data.logging;
  NSPR.initialize(data.nsprFile);
  NSS.initialize(data.nssFile);
  SSL.initialize(data.sslFile);

  this.buffer = new NSPR.lib.buffer(512);
  this.wakeup = Serialization.deserializeDescriptor(data.fd);
  this.listenSocket = new ListenSocket(data.listenSocket);
};

ShuffleWorker.prototype.addConnection = function(data) {
  var socketOption = NSPR.types.PRSocketOptionData({'option' : 0, 'value' : 1});
  var client = Serialization.deserializeDescriptor(data.client);
  var server = Serialization.deserializeDescriptor(data.server);

  NSPR.lib.PR_SetSocketOption(client, socketOption.address());
  NSPR.lib.PR_SetSocketOption(server, socketOption.address());

  this.connectionPairs.push(new ShuffleWorkerItem(client, server));
};

ShuffleWorker.prototype.handleConnectionEvents = function(pollfds, 
    connectionsLength) {
  var modified = false;

  for (var i=connectionsLength-2;i>=0;i-=2) {
    var result = this.connectionPairs[i/2]
      .shuffle(pollfds[i].out_flags, pollfds[i+1].out_flags);

    if (result[0]) { // Closed
      this.connectionPairs[i/2].close();
      this.connectionPairs.splice(i/2, 1);
    }

    if (result[0] || result[1]) modified = true;
  }

  return modified;
};

ShuffleWorker.prototype.isWakeupEvent = function(flags) {
  if ((flags & NSPR.lib.PR_POLL_READ) !== 0) {
    NSPR.lib.PR_Read(this.wakeup, this.buffer, 5);
    return true;
  }

  return false;
};

ShuffleWorker.prototype.isAcceptEvent = function(flags) {
  return (flags & NSPR.lib.PR_POLL_READ) !== 0;
};

ShuffleWorker.prototype.handleAcceptEvent = function() {
  var clientSocket = this.listenSocket.accept();
  postMessage({'clientSocket' : clientSocket.serialize()});
};

ShuffleWorker.prototype.processConnections = function() {
  var descriptors = this.initializeDescriptors();
  var pollfds = descriptors.pollfds;
  var connectionsLength = descriptors.connectionsLength;

  while (NSPR.lib.PR_Poll(pollfds, pollfds.length, -1) !== -1) {

    if (this.isWakeupEvent(pollfds[connectionsLength].out_flags)) {
      CV9BLog.worker_shuffle('Bailing out for wakeup...');
      return;
    }

    if (this.isAcceptEvent(pollfds[connectionsLength + 1].out_flags)) {
      CV9BLog.worker_shuffle('Handling accept event...');
      this.handleAcceptEvent();
    }

    if (this.handleConnectionEvents(pollfds, connectionsLength)) {
      descriptors = this.initializeDescriptors();
      pollfds = descriptors.pollfds;
      connectionsLength = descriptors.connectionsLength;
    }
  }
};

var shuffleWorker = new ShuffleWorker();

onmessage = function(event) {
  try {
    switch (event.data.type) {
    case TYPE_INITIALIZE:
      CV9BLog.worker_shuffle('Initializing...');
      shuffleWorker.initialize(event.data);
      break;
    case TYPE_CONNECTION:
      CV9BLog.worker_shuffle('Adding connection...');
      shuffleWorker.addConnection(event.data);
      break;
    }
    shuffleWorker.processConnections();
    CV9BLog.worker_shuffle('Done');
  } catch (e) { CV9BLog.worker_shuffle.error(e); }
};
