'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const FullNode = require('../lib/node/fullnode');
const WalletPlugin = require('../lib/wallet/plugin');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Output = require('../lib/primitives/output');
// const {Resource} = require('../lib/dns/resource');
const {types, grindName} = require('../lib/covenants/rules');
const {forEventCondition} = require('./util/common');

/**
 * Wallet balance tracking tests.
 *
 * TODO:
 *  - Add CoinView support to chain <-> wallet and update input tests.
 *  - Add coin discovery on unconfirm
 *  - Add spent coin state recovery on unconfirm/confirm for pending txs.
 */

/**
 * @property {Number} tx
 * @property {Number} coin
 * @property {Number} confirmed
 * @property {Number} unconfirmed
 * @property {Number} ulocked - unconfirmed locked
 * @property {Number} clocked - confirmed locked
 */

class BalanceObj {
  constructor(options) {
    options = options || {};

    this.tx = options.tx || 0;
    this.coin = options.coin || 0;
    this.confirmed = options.confirmed || 0;
    this.unconfirmed = options.unconfirmed || 0;
    this.ulocked = options.ulocked || 0;
    this.clocked = options.clocked || 0;
  }

  clone() {
    return new BalanceObj(this);
  }

  cloneWithDelta(obj) {
    return this.clone().apply(obj);
  }

  fromBalance(obj) {
    this.tx = obj.tx;
    this.coin = obj.coin;
    this.confirmed = obj.confirmed;
    this.unconfirmed = obj.unconfirmed;
    this.ulocked = obj.lockedUnconfirmed;
    this.clocked = obj.lockedConfirmed;

    return this;
  }

  apply(balance) {
    this.tx += balance.tx || 0;
    this.coin += balance.coin || 0;
    this.confirmed += balance.confirmed || 0;
    this.unconfirmed += balance.unconfirmed || 0;
    this.ulocked += balance.ulocked || 0;
    this.clocked += balance.clocked || 0;

    return this;
  }

  static fromBalance(wbalance) {
    return new this().fromBalance(wbalance);
  }
}

const network = Network.get('regtest');
const mnemData = require('./data/mnemonic-english.json');

// make wallets addrs deterministic.
const phrases = mnemData.map(d => Mnemonic.fromPhrase(d[1]));

const {
  treeInterval
} = network.names;

/**
 * @enum {Number}
 */

const DISCOVER_TYPES = {
  NONE: 0,
  BEFORE_CONFIRM: 1,
  BEFORE_UNCONFIRM: 2,
  BEFORE_ERASE: 3,
  BEFORE_BLOCK_CONFIRM: 4,
  BEFORE_BLOCK_UNCONFIRM: 5
};

const openingPeriod = treeInterval + 2;

// default gen wallets.
const WALLET_N = 5;
const GRIND_NAME_LEN = 10;

// Wallet consts
const DEFAULT_ACCOUNT = 'default';

const INIT_BLOCKS = treeInterval;
const INIT_FUND = 10e6;

const INIT_BALANCE = new BalanceObj({
  tx: 1,
  coin: 1,
  unconfirmed: INIT_FUND,
  confirmed: INIT_FUND,
  ulocked: 0,
  clocked: 0
});

const HARD_FEE = 1e4;
const SEND_AMOUNT = 2e6;
const BLIND_AMOUNT = 1e6;
const BID_AMOUNT = BLIND_AMOUNT / 4;

/*
 * Wallet helpers
 */

async function getAddrStr(wallet, acct = 0) {
  return (await wallet.receiveAddress(acct)).toString(network);
}

function getAheadAddr(account, ahead, master) {
  const nextIndex = account.receiveDepth + account.lookahead + ahead;
  const receiveKey = account.deriveReceive(nextIndex, master);
  const nextAddr = receiveKey.getAddress();

  return { nextAddr, receiveKey };
}

async function catchUpToAhead(wallet, accountName, ahead) {
  for (let i = 0; i < ahead; i++)
    await wallet.createReceive(accountName);
};

async function resign(wallet, mtx) {
  for (const input of mtx.inputs)
    input.witness.length = 0;

  await wallet.sign(mtx);
};

/*
 * Balance helpers
 */

/**
 * @returns {Promise<BalanceObj>}
 */

async function getBalanceObj(wallet, account) {
  const balance = await wallet.getBalance(account);
  return BalanceObj.fromBalance(balance.getJSON(true));
}

async function assertBalance(wallet, account, expected, message) {
  const balance = await getBalanceObj(wallet, account);
  assert.deepStrictEqual(balance, expected, message);
}

/**
 * @param {BalanceObj} balance
 * @param {BalanceObj} delta
 * @returns {BalanceObj}
 */

function applyDelta(balance, delta) {
  return balance.clone().apply(delta);
}

describe('Wallet Balance', function() {
  let node, chain, wdb, genWallets = WALLET_N;;

  // wallets
  let primary, walletIndex, allWallets = [];

  /*
   * Contextual helpers
   */

  const prepare = () => {
    node = new FullNode({
      network: network.type,
      memory: true,
      plugins: [WalletPlugin],
      noDNS: true,
      noNS: true
    });

    chain = node.chain;

    node.once('error', (err) => {
      assert(false, err);
    });

    wdb = node.require('walletdb').wdb;
  };

  const mineBlocks = async (blocks) => {
    const tipHeight = chain.tip.height;
    const forWalletBlock = forEventCondition(wdb, 'block connect', (entry) => {
      return entry.height === tipHeight + 1;
    });
    await node.rpc.generateToAddress([blocks, await getAddrStr(primary)]);
    await forWalletBlock;
  };

  const setupWallets = async () => {
    walletIndex = 0;
    primary = await wdb.get('primary');

    allWallets = [];
    for (let i = 0; i < genWallets; i++) {
      const name = 'wallet' + i;
      const wallet = await wdb.create({ id: name, mnemonic: phrases[i] });
      allWallets.push(wallet);
    }
  };

  const fundWallets = async () => {
    await mineBlocks(INIT_BLOCKS);
    const addrs = [];

    for (let i = 0; i < genWallets; i++)
      addrs.push(await getAddrStr(allWallets[i], DEFAULT_ACCOUNT));

    await primary.send({
      outputs: addrs.map((addr) => {
        return {
          value: INIT_FUND,
          address: addr
        };
      })
    });
    await mineBlocks(1);
  };

  const getNextWallet = (index) => {
    const i = index ? index : walletIndex++;

    if (!allWallets[i])
      throw new Error('There are not enough wallets, can not get at index: ' + i);

    return {
      wallet: allWallets[i],
      wid: allWallets[i].id,
      accountName: DEFAULT_ACCOUNT,
      opts: {
        account: DEFAULT_ACCOUNT,
        hardFee: HARD_FEE
      }
    };
  };

  const forWTX = (id, hash) => {
    return forEventCondition(wdb, 'tx', (wallet, tx) => {
      return wallet.id === id && tx.hash().equals(hash);
    });
  };

  /*
   * beforeall and afterall for each describe
   */

  const beforeAll = async () => {
    prepare();

    await node.open();
    await setupWallets();
    await fundWallets();
  };

  const afterAll = async () => {
    await node.close();
    node = null;

    // reduce time of the tests.
    if (walletIndex !== genWallets)
      console.log(`Leftover wallets, used: ${walletIndex} of ${genWallets}.`);

    genWallets = WALLET_N;
  };

  /*
   * Balance testing steps.
   */

  /**
   * @callback SetupFunction
   * @param {Wallet} wallet
   * @param {Account} account
   * @param {Number} ahead
   * @param {Object} [opts]
   */

  /**
   * @typedef {Object} TestBalances
   * @property {BalanceObj} balances.initialBalance
   * @property {BalanceObj} balances.receiveBalance
   * @property {BalanceObj} balances.confirmedBalance
   * @property {BalanceObj} balances.unconfirmedBalance
   * @property {BalanceObj} balances.eraseBalance
   * @property {BalanceObj} balances.blockConfirmBalance
   * @property {BalanceObj} balances.blockUnconfirmedBalance
   * @property {BalanceObj} [balances.blockFinalConfirmBalance]
   */

  /**
   * @callback BalanceTestFunction
   * @param {TestBalances} balances
   * @param {DISCOVER_TYPES} discoverAt
   * @param {Object} opts
   */

  /**
   * Supports missing address/discoveries at certain points.
   * @param {SetupFunction} [setupFn]
   * @param {SetupFunction} receiveFn
   * @param {Number} ahead
   * @returns {BalanceTestFunction}
   */

  const balanceTest = (setupFn, receiveFn, ahead) => {
    return async (balances, discoverAt, opts) => {
      const {wallet, accountName} = getNextWallet();
      const account = await wallet.getAccount(accountName);

      const {
        initialBalance,
        receiveBalance,
        confirmedBalance,
        unconfirmedBalance,
        eraseBalance,
        blockConfirmBalance,
        blockUnconfirmedBalance
      } = balances;

      if (setupFn)
        await setupFn(wallet, account, ahead, opts);

      await assertBalance(wallet, accountName, initialBalance,
        'Initial balance is not correct.');

      await receiveFn(wallet, account, ahead, opts);
      await assertBalance(wallet, accountName, receiveBalance,
        'Receive balance is not correct.');

      if (discoverAt === DISCOVER_TYPES.BEFORE_CONFIRM)
        await catchUpToAhead(wallet, accountName, ahead);

      await mineBlocks(1);
      await assertBalance(wallet, accountName, confirmedBalance,
        'Confirmed balance is not correct.');

      // now unconfirm
      if (discoverAt === DISCOVER_TYPES.BEFORE_UNCONFIRM)
        await catchUpToAhead(wallet, accountName, ahead);

      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, accountName, unconfirmedBalance,
        'Unconfirmed balance is not correct.');

      // now erase
      if (discoverAt === DISCOVER_TYPES.BEFORE_ERASE)
        await catchUpToAhead(wallet, accountName, ahead);

      await wallet.zap(accountName, 0);
      await assertBalance(wallet, accountName, eraseBalance,
        'Erase balance is not correct.');

      if (discoverAt === DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM)
        await catchUpToAhead(wallet, accountName, ahead);

      // Final look at full picture.
      await wdb.scan(chain.tip.height - 1);
      await assertBalance(wallet, accountName, blockConfirmBalance,
        'Block confirm balance is not correct.');

      if (discoverAt === DISCOVER_TYPES.BEFORE_BLOCK_UNCONFIRM)
        await catchUpToAhead(wallet, accountName, ahead);

      // Unconfirm
      await wdb.revert(chain.tip.height - 1);
      await assertBalance(wallet, accountName, blockUnconfirmedBalance,
        'Block unconfirmed balance is not correct.');

      // Clean up wallet.
      await wdb.scan(chain.tip.height - 1);

      let finalBalance = blockConfirmBalance;

      if (balances.blockFinalConfirmBalance)
        finalBalance = balances.blockFinalConfirmBalance;

      await assertBalance(wallet, accountName, finalBalance,
        'Final block confirm balance is not correct.');
    };
  };

  describe('NONE -> NONE* (normal receive)', function() {
    before(() => {
      genWallets = 5;
      return beforeAll();
    });

    after(afterAll);

    const receive = async (wallet, account, ahead, opts) => {
      const recvAddr = await wallet.receiveAddress();
      const {nextAddr} = getAheadAddr(account, ahead);

      // Send one to the normal address
      // Send another one to the gapped/missed adress
      await primary.send({
        outputs: [{
          address: recvAddr,
          value: SEND_AMOUNT
        }, {
          address: nextAddr,
          value: SEND_AMOUNT
        }]
      });
    };

    // account.lookahead + AHEAD
    const AHEAD = 10;
    const test = balanceTest(null, receive, AHEAD);

    it('should handle normal receive (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: SEND_AMOUNT
      });

      balances.unconfirmedBalance = balances.receiveBalance;
      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.receiveBalance;

      await test(balances, DISCOVER_TYPES.NONE);
    });

    it('should handle normal receive, discover on confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      // here we discover second coin.
      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        coin: 1,
        confirmed: SEND_AMOUNT * 2,
        unconfirmed: SEND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -SEND_AMOUNT * 2
      });

      balances.eraseBalance = balances.initialBalance;

      // We have already derived, so this should discover right away
      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await test(balances, DISCOVER_TYPES.BEFORE_CONFIRM);
    });

    it('should handle normal receive, discover on unconfirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: SEND_AMOUNT
      });

      // TODO: Unconfirm balance update.
      // TODO: this should detect new coins on unconfirm as well
      // and apply them to the unconfirm balance. (coin +1, unconfirm: +value)
      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -SEND_AMOUNT
      });

      // TODO: Should be:
      // balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
      //   coin: 1,
      //   unconfirmed: SEND_AMOUNT
      //   confirmed: -SEND_AMOUNT
      // });

      balances.eraseBalance = balances.initialBalance;

      // We have already derived, so this should discover right away
      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        confirmed: SEND_AMOUNT * 2,
        unconfirmed: SEND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        confirmed: -SEND_AMOUNT * 2
      });

      await test(balances, DISCOVER_TYPES.BEFORE_UNCONFIRM);
    });

    // This is same as discover on block confirm.
    it('should handle normal receive, discover on erase/block confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: SEND_AMOUNT
      });

      balances.unconfirmedBalance = balances.receiveBalance;

      // Those credits are gone anyway, so nothing will be added to the balances.
      balances.eraseBalance = balances.initialBalance;

      balances.blockConfirmBalance = applyDelta(balances.eraseBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: SEND_AMOUNT * 2,
        confirmed: SEND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        confirmed: -SEND_AMOUNT * 2
      });

      await test(balances, DISCOVER_TYPES.BEFORE_ERASE);
      await test(balances, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it.skip('should handle normal receive, discover on block unconfirm', async () => {
    });
  });

  describe('NONE* -> NONE (spend our credits)', function() {
    before(() => {
      genWallets = 1;
      return beforeAll();
    });

    after(afterAll);

    let coins, nextAddr, receiveKey;

    const setup = async (wallet, account, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const aheadAddr = getAheadAddr(account, ahead, wallet.master);
      nextAddr = aheadAddr.nextAddr;
      receiveKey = aheadAddr.receiveKey;

      // Create transaction that creates two coins:
      //  1. normal coin
      //  2. one gapped/missed coin
      const fundTX = await primary.send({
        sort: false,
        outputs: [{
          address: recvAddr,
          value: SEND_AMOUNT
        }, {
          address: nextAddr,
          value: SEND_AMOUNT + HARD_FEE
        }]
      });

      await mineBlocks(1);

      coins = [
        Coin.fromTX(fundTX, 0, chain.tip.height),
        Coin.fromTX(fundTX, 1, chain.tip.height)
      ];
    };

    const receive = async (wallet, account, ahead) => {
      const outAddr = await primary.receiveAddress();
      const changeAddr = await wallet.changeAddress();

      // spend both coins in one tx.
      const mtx = new MTX();

      mtx.addOutput(new Output({
        address: outAddr,
        value: SEND_AMOUNT * 2
      }));

      // HARD_FEE is paid by gapped/missed coin.
      await mtx.fund(coins, {
        hardFee: HARD_FEE,
        changeAddress: changeAddr
      });

      await wallet.sign(mtx);
      await mtx.signAsync(receiveKey);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const test = balanceTest(setup, receive, AHEAD);

    it('should spend normal credit (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,
        coin: 1,
        confirmed: SEND_AMOUNT,
        unconfirmed: SEND_AMOUNT
      });

      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: -1,
        unconfirmed: -SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: -SEND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: SEND_AMOUNT
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: -1,
        confirmed: -SEND_AMOUNT,
        unconfirmed: -SEND_AMOUNT
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        confirmed: SEND_AMOUNT
      });

      await test(balances, DISCOVER_TYPES.NONE);
    });

    it.skip('should spend credit (discover before confirm)', async () => {
      // TODO: Implement with coinview update.
      // This will be no different than normal credit spend if
      // we don't receive CoinView from the chain. So skip this until we
      // have that feature.
    });

    // We don't have any details about inputs, so it's not possible to recover them.
    // it('should spend credit (discover before unconfirm)', async () => {});
    // it('should spend credit (discover before erase)', async () => {});

    it.skip('should spend credit (discover before block confirm)', async () => {
      // This will be no different than normal credit spend if
      // we don't receive CoinView from the chain. So skip this until we
      // have that feature.
    });

    // We don't have any details about inputs, so it's not possible to recover them.
    // it('should spend credit (discover before block unconfirm)', async () => { });
  });

  describe('NONE* -> NONE* (receive and spend in pending)', function() {
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    const receive = async (wallet, account, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const aheadAddr = getAheadAddr(account, ahead, wallet.master);
      const nextAddr = aheadAddr.nextAddr;
      const receiveKey = aheadAddr.receiveKey;

      // Create transaction that creates two coins:
      //  1. normal coin
      //  2. one gapped/missed coin
      const fundTX = await primary.send({
        sort: false,
        outputs: [{
          address: recvAddr,
          value: SEND_AMOUNT
        }, {
          address: nextAddr,
          value: SEND_AMOUNT + HARD_FEE
        }]
      });

      const coins = [
        Coin.fromTX(fundTX, 0, chain.tip.height),
        Coin.fromTX(fundTX, 1, chain.tip.height)
      ];

      const outAddr = await primary.receiveAddress();
      const changeAddr = await wallet.changeAddress();

      // spend both coins in one tx.
      const mtx = new MTX();

      mtx.addOutput(new Output({
        address: outAddr,
        value: SEND_AMOUNT * 2
      }));

      // HARD_FEE is paid by gapped/missed coin.
      await mtx.fund(coins, {
        hardFee: HARD_FEE,
        changeAddress: changeAddr
      });

      await wallet.sign(mtx);
      await mtx.signAsync(receiveKey);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const test = balanceTest(null, receive, AHEAD);

    // For this test, the balances are same for all the test cases,
    // but for different reasons.
    const initialBalance = INIT_BALANCE;

    // We receive 2 transactions (receiving one and spending one)
    // But we spend discovered output right away.
    const receiveBalance = applyDelta(initialBalance, {
      tx: 2,
      coin: 0,
      unconfirmed: 0
    });

    // Nothing changes for confirmed either. (Coins are spent in pending)
    const confirmedBalance = applyDelta(receiveBalance, {});
    const unconfirmedBalance = applyDelta(confirmedBalance, {});

    // We no longer have two txs.
    const eraseBalance = applyDelta(unconfirmedBalance, { tx: -2 });
    const blockConfirmBalance = confirmedBalance;
    const blockUnconfirmedBalance = unconfirmedBalance;

    const balances = {
      initialBalance,
      receiveBalance,
      confirmedBalance,
      unconfirmedBalance,
      eraseBalance,
      blockConfirmBalance,
      blockUnconfirmedBalance
    };

    it('should spend credit (no discovery)', async () => {
      await test(balances, DISCOVER_TYPES.NONE);
    });

    it('should spend credit (discover on confirm)', async () => {
      // Here we discover another output on Confirm.
      // But it is spent right away from the next transaction
      // that gets committed. So nothing will actually change.
      await test(balances, DISCOVER_TYPES.BEFORE_CONFIRM);
    });

    it('should spend credit (discover on unconfirm)', async () => {
      // Here we don't actually discover output. We could but that
      // is another TODO: Add spent in pending credit discovery.
      // Balance will be the same, but the entries in the database
      // for the coin will be different.
      await test(balances, DISCOVER_TYPES.BEFORE_UNCONFIRM);
    });

    it('should spend credit (discover on erase)', async () => {
      // Nothing should happen as outputs go away.. Does not matter
      // if we discover.
      await test(balances, DISCOVER_TYPES.BEFORE_ERASE);
    });

    it('should spend credit (discover on block confirm)', async () => {
      // Here we discover the coins, but because they are spent right away
      // it must not change the coin/balance.
      // Test for that is covered above in normal receive.
      await test(balances, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it('should spend credit (discover on block unconfirm)', async () => {
      // Same as UNCONFIRM note.
      await test(balances, DISCOVER_TYPES.BEFORE_BLOCK_UNCONFIRM);
    });
  });

  /*
   * Lock balances
   */

  describe('NONE -> OPEN', function() {
    before(() => {
      genWallets = 1;
      return beforeAll();
    });

    after(afterAll);

    const receive = async (wallet) => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await wallet.sendOpen(name, false, {
        hardFee: HARD_FEE
      });
    };

    const test = balanceTest(null, receive, 0);

    it('should handle open', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;

      // TODO: This should not introduce new COIN.
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: -HARD_FEE
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE
      });

      // TODO: Same as above coin amount should not change.
      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE
      });

      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await test(balances, DISCOVER_TYPES.NONE);
    });
  });

  describe('NONE -> BID* (normal receive)', function() {
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    const setup = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendNormalBid = async (wallet, account, ahead) => {
      const {nextAddr} = getAheadAddr(account, ahead);
      const txOpts = { hardFee: HARD_FEE };

      const bidMTX = await wallet.createBatch([
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT],
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);
      bidMTX.outputs[1].address = nextAddr;

      await resign(wallet, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const test = balanceTest(setup, sendNormalBid, AHEAD);

    it('should receive bid (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // We have additional coin because: output -> BID + Change
        // Additional BID is undiscovered.
        coin: 1,
        // Bid we are not aware of is seen as spent.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT,
        ulocked: -BLIND_AMOUNT
      });

      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await test(balances, DISCOVER_TYPES.NONE);
    });

    it('should receive bid (discover on confirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // We have additional coin because: output -> BID + Change
        // Additional BID is undiscovered.
        coin: 1,
        // Bid we are not aware of is seen as spent.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        // We discovered another bid is also ours..
        coin: 1,
        // So we add discovered bid back to our balance
        unconfirmed: BLIND_AMOUNT,
        // Confirm will only deduce fee.
        confirmed: -HARD_FEE,
        // also add them to the unconfirmed locks.
        ulocked: BLIND_AMOUNT,
        // We lock both in confirmed.
        clocked: BLIND_AMOUNT * 2
      });

      // Now everything flows as if we have received both at once.
      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE,
        clocked: -BLIND_AMOUNT * 2
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -2,
        unconfirmed: HARD_FEE,
        ulocked: -BLIND_AMOUNT * 2
      });

      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await test(balances, DISCOVER_TYPES.BEFORE_CONFIRM);
    });

    it('should receive bid (discover on unconfirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      // TODO: Unconfirm updates to the balance
      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      // TODO: Unconfirm balance update.
      // TODO: This after unconfirm discovery should be:
      // balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
      //   // revert confirmed
      //   confirmed: HARD_FEE + BLIND_AMOUNT,
      //   // nothing is clocked.
      //   clocked: -BLIND_AMOUNT,

      //   // we now count newly discovered bid to the balance.
      //   unconfirmed: BLIND_AMOUNT,
      //   // we also ulock that amount
      //   ulocked: BLIND_AMOUNT,
      //   // new bid is our coin.
      //   coin: 1
      // });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT,
        ulocked: -BLIND_AMOUNT
      });

      // Insert(block) recovers balance.
      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: -HARD_FEE,
        confirmed: -HARD_FEE,
        ulocked: BLIND_AMOUNT * 2,
        clocked: BLIND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        clocked: -BLIND_AMOUNT * 2,
        confirmed: HARD_FEE
      });

      await test(balances, DISCOVER_TYPES.BEFORE_UNCONFIRM);
    });

    // this should be same as discover on block confirm.
    it('should receive bid (discover on erase/block confirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT,
        ulocked: -BLIND_AMOUNT
      });

      // Start from init balance
      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: -HARD_FEE,
        confirmed: -HARD_FEE,
        clocked: BLIND_AMOUNT * 2,
        ulocked: BLIND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        confirmed: HARD_FEE,
        clocked: -BLIND_AMOUNT * 2
      });

      await test(balances, DISCOVER_TYPES.BEFORE_ERASE);
      await test(balances, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it('should receive bid (discover on block unconfirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT,
        ulocked: -BLIND_AMOUNT
      });

      // Insert(block) recovers balance.
      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: -HARD_FEE,
        confirmed: -HARD_FEE,
        ulocked: BLIND_AMOUNT * 2,
        clocked: BLIND_AMOUNT * 2
      });

      // TODO: Unconfirm balance update.
      // TODO: This after unconfirm discovery should be:
      // balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
      //   // revert confirmed
      //   confirmed: HARD_FEE + BLIND_AMOUNT,
      //   // nothing is clocked.
      //   clocked: -BLIND_AMOUNT,

      //   // we now count newly discovered bid to the balance.
      //   unconfirmed: BLIND_AMOUNT,
      //   // we also ulock that amount
      //   ulocked: BLIND_AMOUNT,
      //   // new bid is our coin.
      //   coin: 1
      // });
      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        clocked: -BLIND_AMOUNT * 2,
        confirmed: HARD_FEE
      });

      await test(balances, DISCOVER_TYPES.BEFORE_UNCONFIRM);
    });
  });

  describe('NONE -> BID* (foreign bid)', function() {
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    const setup = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendForeignBid = async (wallet, account, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const {nextAddr} = getAheadAddr(account, ahead);
      const txOpts = { hardFee: HARD_FEE };

      const bidMTX = await primary.createBatch([
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT],
        ['BID', name, BID_AMOUNT, BLIND_AMOUNT]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      bidMTX.outputs[0].address = recvAddr;
      bidMTX.outputs[1].address = nextAddr;

      await resign(primary, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const testForeign = balanceTest(setup, sendForeignBid, AHEAD);

    it('should receive foreign bid (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.receiveBalance;

      await testForeign(balances, DISCOVER_TYPES.NONE);
    });

    it('should receive foreign bid (on confirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      // here we discover another coin
      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        coin: 1,
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT,
        confirmed: BLIND_AMOUNT * 2,
        clocked: BLIND_AMOUNT * 2
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT * 2,
        clocked: -BLIND_AMOUNT * 2
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testForeign(balances, DISCOVER_TYPES.BEFORE_CONFIRM);
    });

    it('should receive foreign bid (on unconfirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      // TODO: Unconfirm balance update.
      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = balances.initialBalance;
      // Currently it's as if we discovered them after block confirm
      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        confirmed: BLIND_AMOUNT * 2,
        clocked: BLIND_AMOUNT * 2,
        unconfirmed: BLIND_AMOUNT * 2,
        ulocked: BLIND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        confirmed: -BLIND_AMOUNT * 2,
        clocked: -BLIND_AMOUNT * 2
      });

      await testForeign(balances, DISCOVER_TYPES.BEFORE_UNCONFIRM);
    });

    it('should receive foreign bid (on erase/block confirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: BLIND_AMOUNT * 2,
        ulocked: BLIND_AMOUNT * 2,
        confirmed: BLIND_AMOUNT * 2,
        clocked: BLIND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmBalance, {
        confirmed: -BLIND_AMOUNT * 2,
        clocked: -BLIND_AMOUNT * 2
      });

      await testForeign(balances, DISCOVER_TYPES.BEFORE_ERASE);
      await testForeign(balances, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it('should receive foreign bid (block unconfirm)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.receiveBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.receiveBalance, {
        confirmed: BLIND_AMOUNT,
        clocked: BLIND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT,
        clocked: -BLIND_AMOUNT
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmBalance = balances.confirmedBalance;

      // TODO: Unconfirm balance update
      balances.blockUnconfirmedBalance = balances.receiveBalance;
      // final confirm
      balances.blockFinalConfirmBalance = applyDelta(balances.blockConfirmBalance, {
        coin: 1,
        confirmed: BLIND_AMOUNT,
        clocked: BLIND_AMOUNT,
        unconfirmed: BLIND_AMOUNT,
        ulocked: BLIND_AMOUNT
      });
      await testForeign(balances, DISCOVER_TYPES.BEFORE_BLOCK_UNCONFIRM);
    });
  });
});
