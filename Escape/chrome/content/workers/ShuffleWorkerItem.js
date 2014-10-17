
function ShuffleWorkerItem(client, server) {
  this.client = client;
  this.server = server;

  this.clientBuffer = new NSPR.lib.buffer(4096);
  this.clientBufferLength = 0;

  this.serverBuffer = new NSPR.lib.buffer(4096);
  this.serverBufferLength = 0;

  this.clientMode = NSPR.lib.PR_POLL_READ;
  this.serverMode = NSPR.lib.PR_POLL_READ;
  this.modified = false;
  this.closed = false;
}

ShuffleWorkerItem.prototype.isSocketClosed = function(flags) {
  return ((flags & NSPR.lib.PR_POLL_EXCEPT) !== 0) ||
    ((flags & NSPR.lib.PR_POLL_ERR) !== 0)    ||
    ((flags & NSPR.lib.PR_POLL_NVAL) !== 0);
};

ShuffleWorkerItem.prototype.getPollDesc = function(clientPollDesc, 
    serverPollDesc) {
  clientPollDesc.contents.fd = this.client;
  clientPollDesc.contents.in_flags = NSPR.lib.PR_POLL_EXCEPT | 
    NSPR.lib.PR_POLL_ERR | this.clientMode;
  clientPollDesc.contents.out_flags = 0;

  serverPollDesc.contents.fd = this.server;
  serverPollDesc.contents.in_flags = NSPR.lib.PR_POLL_EXCEPT | 
    NSPR.lib.PR_POLL_ERR | this.serverMode;
  serverPollDesc.contents.out_flags = 0;

  this.modified = false;
};

ShuffleWorkerItem.prototype.constructRemainingBuffer = function(existing, 
    offset, length) {
  var remainingBuffer = new NSPR.lib.buffer(4096);

  for (var i=0;i<length;i++)
    remainingBuffer[i] = existing[i+offset];

  return remainingBuffer;
};

ShuffleWorkerItem.prototype.readFromServer = function() {
  var read = NSPR.lib.PR_Read(this.server, this.serverBuffer, 4095);

  if ((read === 0) || ((read === -1) && (NSPR.lib.PR_GetError() !== 
      NSPR.lib.PR_WOULD_BLOCK_ERROR))) {
    CV9BLog.proto('Got normal close from SERVER');
    this.closed = true;
    return;
  }

  var written = NSPR.lib.PR_Write(this.client, this.serverBuffer, read);

  if (written === -1)
    written = 0;

  if (written < read) {
    CV9BLog.proto('*** Blocking write to CLIENT *****');
    this.clientMode = this.clientMode | NSPR.lib.PR_POLL_WRITE;
    this.serverMode = this.serverMode & (~NSPR.lib.PR_POLL_READ) ;

    if (written !== 0)
      this.serverBuffer = this.constructRemainingBuffer(this.serverBuffer, 
          written, read-written);

    this.serverBufferLength = read-written;
    this.modified = true;
  }
};

ShuffleWorkerItem.prototype.readFromClient = function() {
  var read = NSPR.lib.PR_Read(this.client, this.clientBuffer, 4095);

  if ((read === 0) || ((read === -1) && (NSPR.lib.PR_GetError() !== 
      NSPR.lib.PR_WOULD_BLOCK_ERROR))) {
    CV9BLog.proto('Got normal close from CLIENT');
    this.closed = true;
    return;
  }

  var written = NSPR.lib.PR_Write(this.server, this.clientBuffer, read);

  if (written === -1)
    written = 0;

  // var sent = this.clientBuffer.readString().slice(0, written);
  // CV9BLog.worker_shuffle('------- Sent TO SERVER:', sent);

  if (written < read) {
    CV9BLog.proto('**** Blocking write to SERVER *****');
    this.serverMode = this.serverMode | NSPR.lib.PR_POLL_WRITE;
    this.clientMode = this.clientMode & (~NSPR.lib.PR_POLL_READ);

    if (written !== 0)
      this.clientBuffer = this.constructRemainingBuffer(this.clientBuffer, 
          written, read-written);

    this.clientBufferLength = read - written;
    this.modified = true;
  }
};

ShuffleWorkerItem.prototype.writeToClient = function() {
  var written = NSPR.lib.PR_Write(this.client, this.serverBuffer, 
      this.serverBufferLength);

  if (written === -1) {
    if (NSPR.lib.PR_GetError() !== NSPR.lib.PR_WOULD_BLOCK_ERROR) {
      CV9BLog.proto('**** Got write CLOSE from CLIENT **** : ' + 
          NSPR.lib.PR_GetError());
      this.closed = true;
      return;
    }

    written = 0;
  }

  // var sent = this.serverBuffer.readString().slice(0, written);
  // CV9BLog.worker_shuffle('------- Sent TO CLIENT:', sent);

  if (written < this.serverBufferLength) {
    CV9BLog.proto('**** Caught up with half-write to CLIENT ****');
    if (written !== 0)
      this.serverBuffer = this.constructRemainingBuffer(
        this.serverBuffer, written, this.serverBufferLength-written );

    this.serverBufferLength -= written;
  } else {
    CV9BLog.proto('**** Completed full write to CLIENT ****');
    this.serverMode = this.serverMode | NSPR.lib.PR_POLL_READ;
    this.clientMode = this.clientMode & (~NSPR.lib.PR_POLL_WRITE);
    this.modified = true;
  }
};

ShuffleWorkerItem.prototype.writeToServer = function() {
  var written = NSPR.lib.PR_Write(this.server, this.clientBuffer, 
      this.clientBufferLength);

  if (written === -1) {
    if (NSPR.lib.PR_GetError() !== NSPR.lib.PR_WOULD_BLOCK_ERROR) {
      CV9BLog.proto('**** Got write CLOSE from SERVER ****');
      this.closed = true;
      return;
    }

    written = 0;
  }

  if (written < this.clientBufferLength) {
    CV9BLog.proto('**** Caught up with half-write to SERVER ****');
    if (written !== 0)
      this.clientBuffer = this.constructRemainingBuffer(
        this.clientBuffer, written, this.clientBufferLength-written );

    this.clientBufferLength -= written;
  } else {
    CV9BLog.proto('**** Completed full write to SERVER ******');
    this.clientMode = this.clientMode | NSPR.lib.PR_POLL_READ;
    this.serverMode = this.serverMode & (~NSPR.lib.PR_POLL_WRITE);
    this.modified = true;
  }
};

ShuffleWorkerItem.prototype.close = function() {
  NSPR.lib.PR_Close(this.client);
  NSPR.lib.PR_Close(this.server);
};

ShuffleWorkerItem.prototype.shuffle = function(clientFlags, serverFlags) {
  if (this.isSocketClosed(clientFlags) || this.isSocketClosed(serverFlags)) {
    CV9BLog.proto('Got RST close');
    this.closed = true;
    return [this.closed, false];
  }

  if ((clientFlags & NSPR.lib.PR_POLL_READ) > 0)
    this.readFromClient();

  if ((serverFlags & NSPR.lib.PR_POLL_READ) > 0)
    this.readFromServer();

  if ((clientFlags & NSPR.lib.PR_POLL_WRITE) > 0)
    this.writeToClient();

  if ((serverFlags & NSPR.lib.PR_POLL_WRITE) > 0)
    this.writeToServer();

  return [this.closed, this.modified];
};
