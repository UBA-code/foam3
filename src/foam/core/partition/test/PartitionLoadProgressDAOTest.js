/**
 * @license
 * Copyright 2026 The FOAM Authors. All Rights Reserved.
 * http://www.apache.org/licenses/LICENSE-2.0
 */

foam.CLASS({
  package: 'foam.core.partition.test',
  name: 'PartitionLoadProgressDAOTest',
  extends: 'foam.core.test.JSTest',

  requires: [
    'foam.core.partition.PartitionLoadProgressDAO',
    'foam.core.partition.PartitionLoadStatus',
    'foam.core.partition.PartitionLoadWatcher',
    'foam.dao.MDAO',
    'foam.dao.PromisedDAO',
    'foam.u2.dock.Dock'
  ],

  methods: [
    async function runTest(x) {
      try {
        // Status DAO with one active row for service key 'svcA'.
        var statusDAO = this.MDAO.create({ of: this.PartitionLoadStatus });
        await statusDAO.put(this.PartitionLoadStatus.create({
          id: 'jrnA', serviceName: 'svcA', partition: '2026/7',
          totalBytes: 1000, bytesRead: 400
        }));

        var subX = x.createSubContext({ partitionLoadStatusDAO: statusDAO });

        // partitionLoadWatcher and dock are context-scoped services
        // (services.jrl, lazyClient: false), not process-wide singletons --
        // build one of each and place them in the sub-context so every
        // decorator created in that context imports the same instances,
        // mirroring how the real app resolves them via CSpec + imports.
        // a stand-in ctrl, so the cards are not added to the test page
        subX = subX.createSubContext({ ctrl: { add: function() {} } });
        var dock = this.Dock.create(null, subX);
        subX = subX.createSubContext({ dock: dock });
        var watcher = this.PartitionLoadWatcher.create(null, subX);
        watcher.pollInterval = 100;
        subX = subX.createSubContext({ partitionLoadWatcher: watcher });

        // Delegate that resolves after 750ms -- slower than showDelay 400ms,
        // with enough margin past the 500/600/700ms checkpoints below that
        // the settle-triggered unwatch can't race them.
        var slow = this.PromisedDAO.create({
          promise: new Promise(function(resolve) {
            setTimeout(function() {
              resolve(foam.dao.MDAO.create({ of: foam.core.partition.PartitionLoadStatus }, subX));
            }, 750);
          })
        }, subX);

        var dao = this.PartitionLoadProgressDAO.create({
          delegate: slow, serviceKey: 'svcA', showDelay: 400
        }, subX);

        var p = dao.select();

        await new Promise(function(r) { setTimeout(r, 500); });
        x.test(Object.keys(watcher.watched_).length === 1,
            'watcher watching svcA while op pending past showDelay');

        await new Promise(function(r) { setTimeout(r, 100); });
        x.test(dock.items.length === 1 && dock.items[0].title === 'svcA' && dock.items[0].progress === 40,
            'active status row docked as a card at 40%');

        // Fast op mid-flight (slow op still pending until 750ms): must never
        // watch, and must not disturb the slow op's existing watch refcount.
        var fast = this.PartitionLoadProgressDAO.create({
          delegate: this.MDAO.create({ of: this.PartitionLoadStatus }, subX),
          serviceKey: 'svcA', showDelay: 400
        }, subX);
        x.test(dao.partitionLoadWatcher === fast.partitionLoadWatcher,
            'both decorators reach the same context instance');
        await fast.select();

        await new Promise(function(r) { setTimeout(r, 100); });
        x.test(Object.keys(watcher.watched_).length === 1,
            'fast op never triggers watch; slow op refcount undisturbed');
        x.test(dock.items.length === 1, 'slow op card still docked after fast op settles');

        await p;
        x.test(Object.keys(watcher.watched_).length === 0, 'unwatched after slow op settles');
      } catch (e) {
        x.test(false, 'unexpected exception: ' + (e && e.message ? e.message : e));
      }
    }
  ]
});
