
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
  * This class is a holder for the information we pull out of a certificate,
  * such as its fingerprint.
  *
  **/


function CertificateInfo(certificate) {
  this.arena = NSS.lib.PORT_NewArena(2048);
  this.commonName = NSS.lib.CERT_GetCommonName(
      certificate.contents.subject.address());
  this.orgUnitName = NSS.lib.CERT_GetOrgUnitName(
      certificate.contents.subject.address());
  this.altNames = NSS.lib.CERT_GetCertificateNames(certificate, this.arena);
  this.verificationDetails = null;

  this.md5 = this.calculateFingerprint(certificate, NSS.lib.SEC_OID_MD5, 16);
  this.sha1 = this.calculateFingerprint(certificate, NSS.lib.SEC_OID_SHA1, 20);
  CV9BLog.pki('Calculating PKI root...');
  this.isLocalPki = this.calculateTrustedPkiRoot(certificate);
  this.original = CertificateInfo.encodeOriginalCertificate(certificate);
}

CertificateInfo.prototype.calculateTrustedPkiRoot = function(certificate) {
  var status = NSS.lib.CERT_VerifyCertNow(
    NSS.lib.CERT_GetDefaultCertDB(), certificate, 1, 1, null);

  if (status !== 0) {
    return false;
  }

  var certificateChain = NSS.lib.CERT_CertChainFromCert(certificate, 0, 1);
  var derCertificateArray = ctypes.cast(certificateChain.contents.certs,
      ctypes.ArrayType(NSS.types.SECItem, certificateChain.contents.len).ptr)
      .contents;
  var rootDerCertificate = derCertificateArray[certificateChain.contents.len-1];
  var rootCertificate = NSS.lib.CERT_FindCertByDERCert(
      NSS.lib.CERT_GetDefaultCertDB(), rootDerCertificate.address());
  var rootName = NSS.lib.CERT_GetOrgUnitName(
      rootCertificate.contents.subject.address());

  if (!rootName.isNull()) {
    CV9BLog.pki('Root name: ' + rootName.readString());
  }

  var slots = NSS.lib.PK11_GetAllSlotsForCert(rootCertificate, null);

  CV9BLog.pki('Got slots: ' + slots);

  var slotNode = slots.isNull() ? null : slots.contents.head;
  var softwareToken = false;

  CV9BLog.pki('SlotNode: ' + slotNode);

  while (slotNode !== null && !slotNode.isNull()) {
    var tokenName = NSS.lib.PK11_GetTokenName(slotNode.contents.slot)
      .readString();

    CV9BLog.pki('Token: ' + tokenName);

    if (tokenName === 'Software Security Device') {
      softwareToken = true;
      break;
    }

    slotNode = slotNode.contents.next;
  }

  NSS.lib.CERT_DestroyCertificate(rootCertificate);
  NSS.lib.CERT_DestroyCertificateList(certificateChain);

  return softwareToken;
};

CertificateInfo.encodeOriginalCertificate = function(certificate) {
  var derCert = certificate.contents.derCert;
  var asArray = ctypes.cast(derCert.data, ctypes.ArrayType(ctypes.unsigned_char,
      derCert.len).ptr).contents;
  var encoded = '';

  for (var i=0;i<asArray.length;i++) {
    encoded += String.fromCharCode(asArray[i]);
  }

  return btoa(encoded);
};

CertificateInfo.prototype.encodeVerificationDetails = function(details) {
  this.verificationDetails = JSON.stringify(details);
};

CertificateInfo.prototype.calculateFingerprint = function(certificate, type, 
    length) {
  var fingerprint = new NSS.lib.ubuffer(20);

  NSS.lib.PK11_HashBuf(
    type, fingerprint,
    certificate.contents.derCert.data,
    certificate.contents.derCert.len );

  var secItem = NSS.types.SECItem({
    'type' : 0, 
    'data' : fingerprint, 
    'len' : length 
  });
  var fingerprintHex = NSS.lib.CERT_Hexify(secItem.address(), 1);

  return fingerprintHex.readString();
};
