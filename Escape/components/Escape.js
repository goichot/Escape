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
 * Antoine Goichot <https://github.com/goichot/>
 */


/**
  * This XPCOM Component is the main entrypoint for the escape
  * backend processing.  This initializes the backend system (registers
  * the local proxy, sets up the local CA certificate, initializes the
  * database, etc...) and then dispatches outgoing HTTPS requests to the
  * local proxy.
  *
  **/

Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/ctypes.jsm');


function Escape() {
  try {
    this.wrappedJSObject = this;
    this.initializeCtypes();

    this.initializeSettingsManager();
    this.initializeCertificateManager();

    this.initializeLocalProxy();
    this.initializeConnectionManager();
    this.registerProxyObserver();
    this.registerObserverService();

    CV9BLog.core('Escape setup complete');
  } catch (e) {
    CV9BLog.core.error(e, 'Escape init error - ');
  }
}

Escape.prototype = {
  classDescription:   'Escape Javascript Component',
  classID:            Components.ID('{3daeab00-0131-11e4-9191-0800200c9a66}'),
  contractID:         '@ant0ine.g0ich0t.fr/escape;1',
  QueryInterface:     XPCOMUtils.generateQI(
      [Components.interfaces.nsIClassInfo]),
  extensionVersion:   '0.0',
  enabled:            true,
  localProxy:         null,
  flags:              Components.interfaces.nsIClassInfo.THREADSAFE,
  nsprFile:           null,
  nssFile:            null,
  sslFile:            null,
  certificateManager: null,
  timer:              Components.classes['@mozilla.org/timer;1']
                        .createInstance(Components.interfaces.nsITimer),

  initializeCtypes: function() {
    try {
      Components.utils.import('resource://gre/modules/Services.jsm');
      Components.utils.import('resource://gre/modules/ctypes.jsm');

      var FFLibDir = Services.dirsvc.get('GreD', 
          Components.interfaces.nsILocalFile);
      var FFLibGet = function(name, fallback) {
        var libPath = FFLibDir.clone();
        libPath.append(ctypes.libraryName(name));
        if (fallback && !libPath.exists()) {
          var libPathFallback = FFLibDir.clone();
          libPathFallback.append(ctypes.libraryName(fallback));
          if (libPathFallback.exists()) {
            CV9BLog.core('Using fallback (' + fallback + ') for lib ' + name + 
                ': ' + libPathFallback.path);
            libPath = libPathFallback;
          }
        }
        return libPath;
      };

      if (Services.appinfo.OS !== 'WINNT') {
        // Assuming unix-like system - i.e. Linux, FreeBSD.a
        // SInce FF22, all major libs are folded into libxul on unixes, 
        // but separate libs should also be available, so we use these to 
        // (possibly) work with older versions.
        // libxul is used as a fallback just in case of weirder platforms.
        // See: https://bugzilla.mozilla.org/show_bug.cgi?id=648407
        this.nssFile = FFLibGet('nss3', 'xul');
        this.nsprFile = FFLibGet('nspr4', 'xul');
        this.sslFile = FFLibGet('ssl3', 'xul');
      } else {
        // On windows, separate libs are available only until FF22, after which 
        // they're folded into nss3.
        this.nssFile = FFLibGet('nss3');
        this.nsprFile = FFLibGet('nspr4', 'nss3');
        this.sslFile = FFLibGet('ssl3', 'nss3');
      }

      NSPR.initialize(this.nsprFile.path);
      NSS.initialize(this.nssFile.path);
      SSL.initialize(this.sslFile.path);
    } catch (e) {
      CV9BLog.core.error(e, 'Error initializing ctypes - ');
      throw e;
    }
  },

  initializeConnectionManager : function() {
    if (this.certificateManager !== null) {
      this.connectionManager = new ConnectionManager(
        this.localProxy.getListenSocket(),
        this.nssFile,
        this.sslFile,
        this.nsprFile,
        this.certificateManager,
        this.settingsManager );
    }
  },

  initializeLocalProxy: function() {
    this.localProxy = new LocalProxy();
  },

  initializeSettingsManager: function() {
    try {
      this.settingsManager = new SettingsManager();
      this.enabled = this.settingsManager.isEnabled();
    } catch (e) {
      CV9BLog.core('Error initializing settings manager: ' + e);
      throw e;
    }
  },

  initializeCertificateManager: function() {
    CV9BLog.core('Configuring cache...');
    SSL.lib.SSL_ConfigServerSessionIDCache(1000, 60, 60, null);

    try {
      this.certificateManager = new CertificateManager();
    } catch (e) {
      CV9BLog.core('User declined password entry, disabling Escape...');
      this.certificateManager = null;
      this.enabled = false;
      return false;
    }

    if (this.certificateManager.needsReboot) {
      Components.classes['@mozilla.org/toolkit/app-startup;1']
        .getService(Components.interfaces.nsIAppStartup)
        .quit(Components.interfaces.nsIAppStartup.eRestart | 
      Components.interfaces.nsIAppStartup.eAttemptQuit);
    }

    return true;
  },

  setEnabled: function(value) {
    if (value && (this.certificateManager === null)) {
      if (this.initializeCertificateManager())
        this.initializeConnectionManager();
      else
        return;
    }

    this.enabled = value;
    this.settingsManager.setEnabled(value);
    this.settingsManager.savePreferences();
  },

  isEnabled: function() {
    return this.enabled;
  },

  getSettingsManager: function() {
    return this.settingsManager;
  },

  getCertificateManager: function() {
    return this.certificateManager;
  },

  registerObserverService: function() {
    var observerService = Components.classes['@mozilla.org/observer-service;1']
      .getService(Components.interfaces.nsIObserverService);
    observerService.addObserver(this, 'quit-application', false);
    observerService.addObserver(this, 'network:offline-status-changed', false);
  },

  registerProxyObserver: function() {
    var protocolService = 
      Components.classes['@mozilla.org/network/protocol-proxy-service;1']
      .getService(Components.interfaces.nsIProtocolProxyService);

    protocolService.unregisterFilter(this);
    protocolService.registerFilter(this, 9999);
  },

  observe: function(subject, topic, data) {
    if (topic === 'quit-application') {
      CV9BLog.core('Got application shutdown request...');
      if (this.connectionManager !== null)
        this.connectionManager.shutdown();
    } else if (topic === 'network:offline-status-changed') {
      if (data === 'online') {
        CV9BLog.core('Got network state change, shutting down listensocket...');
        if (this.connectionManager !== null)
          this.connectionManager.shutdown();
        CV9BLog.core('Initializing listensocket...');
        this.initializeConnectionManager();
      }
    } else if (topic === 'timer-callback') {
      CV9BLog.core('Got timer update...');
    }
  },


  applyFilter : function(protocolService, uri, proxy) {
    if (!this.enabled)
      return proxy;
    
    var eTLDService = 
      Components.classes["@mozilla.org/network/effective-tld-service;1"]
      .getService(Components.interfaces.nsIEffectiveTLDService);
    
    var whitelistElement = this.settingsManager.getWhitelistElement(uri.host);
    var hostConf = 
      this.settingsManager.getHostConf(eTLDService.getBaseDomain(uri));
    if (uri.scheme === 'https' && (whitelistElement || (hostConf && 
        this.settingsManager.isLocalResolutionSelected()) || 
        this.settingsManager.isCustomSelected())) {
      
      this.connectionManager.setProxyTunnel(proxy);
      if (whitelistElement) {
        this.connectionManager.setNextSNI(whitelistElement.sni);
        this.connectionManager.setEncapsulation(whitelistElement.encapsulation);
        this.connectionManager.setException(whitelistElement.exception);
      } else {
        this.connectionManager.setNextSNI(null);
        this.connectionManager.setEncapsulation(false);
        this.connectionManager.setException(false);
      }
      if (hostConf && this.settingsManager.isLocalResolutionSelected()) 
        this.connectionManager.setDirectIP(hostConf.ip);
      else this.connectionManager.setDirectIP(null);
      
      return this.localProxy.getProxyInfo();
    } else {
      return proxy;
    }
  },

  getInterfaces: function(countRef) {
    var interfaces = [Components.interfaces.nsIClassInfo];
    countRef.value = interfaces.length;
    return interfaces;
  },

  getHelperForLanguage: function getHelperForLanguage(aLanguage) {
    return null;
  }

};

var components = [Escape];

/**
  * XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
  * XPCOMUtils.generateNSGetModule is for Mozilla 1.9.2 (Firefox 3.6).
  */
if (XPCOMUtils.generateNSGetFactory)
  var NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
else
  var NSGetModule = XPCOMUtils.generateNSGetModule(components);

/** Component Loading **/

var loadScript = function(isChrome, subdir, filename) {
  try { logger = CV9BLog.core; }
  catch (e) {
    logger = (filename !== 'Logger.js') ?
      function(line) { dump('Escape.dump: ' + line + '\n'); } :
      function(line) {}; 
  }
  var path = null;
  try {
    path = __LOCATION__.parent.clone();

    if (isChrome) {
      path = path.parent.clone();
      path.append('chrome');
      path.append('content');
    }

    if (subdir !== null) {
      path.append(subdir);
    }

    path.append(filename);

    logger('Loading: ' + path.path);

    var fileProtocol = 
      Components.classes['@mozilla.org/network/protocol;1?name=file']
      .getService(Components.interfaces.nsIFileProtocolHandler);
    var loader = Components.classes['@mozilla.org/moz/jssubscript-loader;1']
      .getService(Components.interfaces.mozIJSSubScriptLoader);

    loader.loadSubScript(fileProtocol.getURLSpecFromFile(path));

    logger('Loaded!');
  } catch (e) { 
    logger('Error loading component script: ' +path.path+ ' : ' + e); 
  }
};

loadScript(true, null, 'Logger.js');

loadScript(true, 'ctypes', 'NSPR.js');
loadScript(true, 'ctypes', 'NSS.js');
loadScript(true, 'ctypes', 'SSL.js');

loadScript(true, 'sockets', 'ListenSocket.js');
loadScript(true, 'sockets', 'ClientSocket.js');
loadScript(true, 'sockets', 'ServerSocket.js');
loadScript(true, 'sockets', 'DNSUDPSocket.js');
loadScript(true, 'ctypes', 'Serialization.js');
loadScript(true, 'ssl', 'CertificateManager.js');
loadScript(true, 'ssl', 'CertificateInfo.js');
loadScript(true, 'proxy', 'HttpProxyServer.js');
loadScript(true, 'proxy', 'WhitelistElement.js');

loadScript(false, null, 'LocalProxy.js');

loadScript(false, null, 'SettingsManager.js');
loadScript(false, null, 'ConnectionManager.js');
