// Copyright (C) 2014 Mike Kazantsev <http://fraggod.net>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>


/**
  * This global object is used for logging all the stuff.
  **/

var CV9BLog = {

  // Set boolean value "extensions.escape.logging.enabled"
  //  to "true" in about:config to enable logging to ff stdout.

  print_all: false,

  // Print logging flag before the message.
  print_component: true,

  // These can be used to selectively enable some logging
  print_flags: {
    'core' : true,
    'settings' : true,
    'worker' : true,
    'worker_conn' : true,
    'worker_shuffle' : true,
    'proto' : true,
    'ui' : true,
    'pki' : true
  },

  // Dump messages directly to stderr, without dump() and such
  use_nspr: true,
  _nspr_fd: null,

  _init: function() {
    try {
      var pref = Components.classes["@mozilla.org/preferences-service;1"]
       .getService(Components.interfaces.nsIPrefService)
       .getBranch('extensions.escape.');
      CV9BLog.print_all = pref.getBoolPref('logging.enabled');
    } catch (error) {}
      

    var add_helper = function(flag) {
      CV9BLog[flag] = function(line, json) {
        return CV9BLog.print(flag.replace('_', '.'), line, json); 
      };
      CV9BLog[flag].error = function(err, prefix) {
        return CV9BLog[flag]((prefix || '') + 'Exception: ' + err, 
            CV9BLog.format_trace(err));
      };
    };
    for (var flag in CV9BLog.print_flags) { add_helper(flag); }
  },

  format: function(line, json) {
    if (json) line += '\n' + CV9BLog.format_json(json);
    if (line.search('\n') !== -1) 
      line = '|\n  ' + line.replace(/^\s+|\s+$/, '').split('\n').join('\n  ');
    return line;
  },

  print: function(flag, line, json, no_nspr) {
    if (!CV9BLog.print_all || (CV9BLog.print_all && !CV9BLog.print_flags[flag]))
      return;
    line = CV9BLog.format(line, json);
    line = 'Escape' + (CV9BLog.print_component ? '.' + flag : '') + 
      ': ' + line + '\n';

    var nspr_err = null;
    if (!no_nspr) {
      try { CV9BLog.print_nspr(line); }
      catch (e) {
        // CV9BLog.print(flag, 'NSPR logging error: ' + e, null, true);
        nspr_err = e;
      }
    }
    if (no_nspr || nspr_err !== null) {
      // Bad (despite being high-level) way of logging, as it sends messages
      //  to different destinations, and probably drops some stuff entirely
      dump(line);
      try { 
        Firebug.Console.log(line); 
      } catch(e) { } // this line works in extensions
      try { 
        console.log(line); 
      } catch(e) { } // this line works in HTML files
    }
  },

  print_nspr: function(line) {
    if (!CV9BLog.use_nspr) throw 'Logging: NSPR disabled';
    if (typeof NSPR === 'undefined' || typeof NSPR.lib === 'undefined')
      throw 'Logging: NSPR unavailable (yet?)';
    if (CV9BLog._nspr_fd === null) {
      CV9BLog._nspr_fd = NSPR.lib.PR_GetSpecialFD(NSPR.lib.PR_StandardError);
      if (CV9BLog._nspr_fd.isNull()) {
        CV9BLog.use_nspr = false;
        throw 'Logging: NSPR failed to get stderr fd';
      }
    }
    // line = 'NSPR: ' + line;
    if (NSPR.lib.PR_Write(CV9BLog._nspr_fd, NSPR.lib.buffer(line), 
        line.length) <= 0)
      throw 'Logging: NSPR write failure';
  },

  // Can be used as: CV9BLog.proto('Got object:' + CV9BLog.format_json(obj));
  format_json: function(obj, cut, indent) {
    if (indent === null) indent = '  ';
    if (typeof obj === 'string') obj = obj.replace(/^\s+|\s+$/, '').split('\n');
    else if (cut === null) cut = 50;
    return CV9BLog._format_json(obj, cut, indent);
  },
  _format_json: function(obj, cut, indent) {
    function IsArray(array) { 
      return !( !array || (!array.length || array.length === 0) ||
          typeof array !== 'object' || !array.constructor || array.nodeType || 
          array.item ); 
    }
    var result = '';
    if (indent === null || typeof indent === 'undefined') indent = '';
    if (cut === null) cut = 16384;
    for (var property in obj) {
      var value = obj[property];
      var txt = '<unknown type>';
      var t = typeof value;
      if (t === 'string') {
        if (value.length > cut) value = value.substr(0, cut) + '...';
        txt = '`' + value.replace('\r', '') + "'"; 
      }
      if (t === 'boolean' || t === 'number') txt = value.toString();
      else if (t === 'object')
        txt = '\n' + CV9BLog._format_json(value, cut, indent + '  ') + '\n';
      result += indent + property + ': ' + txt + '\n';
    }
    return result;
  },

  format_trace: function(err) {
    var stack = err ? err.stack : null;
    if (stack === null || typeof stack === 'undefined') {
      err = new Error();
      err = err.stack.replace(/^.*?\n/, '');
      stack = stack === null ? err : err.replace(/^.*?\n/, '');
    }
    return stack;
  },

};

CV9BLog._init();
