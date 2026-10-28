/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.dao.test',
  name: 'PollingResetDAOTest',
  extends: 'foam.core.test.JSTest',

  documentation: `A client DAO without a cache must tell its listeners to
    re-read once per pollingInterval, while a put from below still reaches
    them. A hidden browser tab and a detached DAO send nothing, and EasyDAO
    adds the decorator when a stanza without a cache sets pollingInterval,
    reaching a listener on a filtered DAO the way a table listens.`,

  implements: [ 'foam.mlang.Expressions' ],

  requires: [
    'foam.dao.EasyDAO',
    'foam.dao.FnSink',
    'foam.dao.MDAO',
    'foam.dao.PollingResetDAO'
  ],

  classes: [
    {
      name: 'Rec',
      properties: [
        { class: 'Long', name: 'id' }
      ]
    }
  ],

  methods: [
    {
      name: 'listenTo',
      documentation: 'Counts the put and reset events a listener on dao receives.',
      code: function(dao) {
        var events = { put: 0, reset: 0 };
        events.sub = dao.listen(this.FnSink.create({
          fn: e => { if ( e in events ) events[e]++; }
        }));
        return events;
      }
    },
    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },
    async function runTest(x) {
      var visible = this.__subContext__.createSubContext({ document: { hidden: false } });
      var hidden  = this.__subContext__.createSubContext({ document: { hidden: true } });

      var dao = this.PollingResetDAO.create({
        delegate: this.MDAO.create({ of: this.Rec }),
        pollingInterval: 20
      }, visible);
      var events = this.listenTo(dao);

      await dao.put(this.Rec.create({ id: 1 }));
      x.test(events.put === 1, 'a put on the delegate reaches the listener');

      await this.wait(100);
      x.test(events.reset > 0, 'a visible tab gets a reset every interval');

      dao.detach();
      var resets = events.reset;
      await this.wait(100);
      x.test(events.reset === resets, 'a detached DAO stops polling');
      events.sub.detach();

      var hiddenDAO = this.PollingResetDAO.create({
        delegate: this.MDAO.create({ of: this.Rec }),
        pollingInterval: 20
      }, hidden);
      var hiddenEvents = this.listenTo(hiddenDAO);
      await this.wait(100);
      x.test(hiddenEvents.reset === 0, 'a hidden tab gets no reset');
      hiddenDAO.detach();
      hiddenEvents.sub.detach();

      var easy = this.EasyDAO.create({ of: this.Rec, daoType: 'ARRAY', pollingInterval: 20 }, visible);
      var easyEvents = this.listenTo(easy.where(this.GT(this.Rec.ID, 0)));
      await this.wait(100);
      x.test(easyEvents.reset > 0, 'EasyDAO without a cache polls a filtered listener when pollingInterval is set');
      easyEvents.sub.detach();
    }
  ]
});
