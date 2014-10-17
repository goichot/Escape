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

/*
 * Contributors : 
 * Moxie Marlinspike <moxie@thoughtcrime.org>
 * Mike Kazantsev <http://fraggod.net>
 */

/**
  * This class is responsible for negotiating SSL with the browser/client
  * connection that we've intercepted and are MITMing on the way out.
  *
  **/


function ServerSocket(fd, serialized) {
  if (typeof serialized !== 'undefined') {
    this.fd = Serialization.deserializeDescriptor(serialized);
  } else {
    this.fd = fd;
  }
}

ServerSocket.prototype.negotiateSSL = function(certificateManager, 
    certificateInfo) {
  var material = certificateManager.generatePeerCertificate(certificateInfo);

  this.fd = SSL.lib.SSL_ImportFD(null, this.fd);
  if (this.fd === null || this.fd.isNull()) throw 'Bad SSL FD!';

  var status = SSL.lib.SSL_ConfigSecureServer(
    this.fd, material.certificate, material.key, SSL.lib.NSS_FindCertKEAType(
        material.certificate) );
  if (status === -1) throw 'Error on SSL_ConfigSecureServer!';

  status = SSL.lib.SSL_ResetHandshake(this.fd, NSPR.lib.PR_TRUE);
  if (status === -1) throw 'Error on SSL_RestHandshake!';

  // var status = NSS.lib.SSL_ForceHandshake(this.fd);

  status = SSL.lib.SSL_ForceHandshakeWithTimeout(this.fd, 
      NSPR.lib.PR_SecondsToInterval(10));
  if (status === -1) throw 'Error completing SSL handshake!';
};

ServerSocket.prototype.available = function() {
  return NSPR.lib.PR_Available(this.fd);
};

ServerSocket.prototype.writeBytes = function(buffer, length) {
  return NSPR.lib.PR_Write(this.fd, buffer, length);
};

ServerSocket.prototype.readFully = function(length) {
  var buffer = new NSPR.lib.unsigned_buffer(length);
  var offset = 0;

  while (offset < length) {
    var read = NSPR.lib.PR_Read(this.fd, buffer.addressOfElement(offset), 
        length-offset);

    if (read < 0)
      return null;

    offset += read;
  }

  return buffer;
};

ServerSocket.prototype.readString = function() {
  CV9BLog.proto('Reading from FD: ' + this.fd);
  var buffer = new NSPR.lib.buffer(4096);
  var read = NSPR.lib.PR_Read(this.fd, buffer, 4095);

  if (read <= 0) {
    return null;
  }

  buffer[read] = 0;
  return buffer.readString();
};

ServerSocket.prototype.serialize = function() {
  return Serialization.serializePointer(this.fd);
};

ServerSocket.prototype.close = function() {
  NSPR.lib.PR_Close(this.fd);
};
