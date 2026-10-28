/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.dao',
  name: 'PollingResetDAO',
  extends: 'foam.dao.ProxyDAO',

  documentation: `
    A client DAO without a cache hears nothing when the server changes its
    data, so an open table keeps showing the rows it read until someone
    presses Refresh. This DAO tells its listeners to re-read once every
    pollingInterval, the same reset the Refresh action sends. Only views
    that are listening re-read, so a DAO no open view is showing sends no
    request. EasyDAO adds it when a client stanza without a cache sets
    pollingInterval.
  `,

  imports: [ 'clearInterval', 'document', 'setInterval' ],

  properties: [
    {
      class: 'Int',
      name: 'pollingInterval',
      units: 'ms'
    }
  ],

  methods: [
    function init() {
      this.SUPER();
      var id = this.setInterval(this.poll, this.pollingInterval);
      this.onDetach(() => this.clearInterval(id));
    },

    function listen_(x, sink, predicate) {
      // ProxyDAO hands listeners down to its delegate, where this DAO's reset
      // would never reach them. Keep them on this DAO instead: the delegate's
      // put, remove and reset still arrive through the forwarded 'on' topic.
      return this.__context__.lookup('foam.dao.AbstractDAO').
        prototype.listen_.call(this, x, sink, predicate);
    }
  ],

  listeners: [
    function poll() {
      // A table in a hidden browser tab skips the read, as CachingDAO.poll does.
      if ( this.document.hidden ) return;
      this.on.reset.pub();
    }
  ]
});
