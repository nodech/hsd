'use strict';

const assert = require('bsert');
const Network = require('../lib/protocol/network');
const Mnemonic = require('../lib/hd/mnemonic');
const FullNode = require('../lib/node/fullnode');
const WalletPlugin = require('../lib/wallet/plugin');
const MTX = require('../lib/primitives/mtx');
const Coin = require('../lib/primitives/coin');
const Output = require('../lib/primitives/output');
const rules = require('../lib/covenants/rules');
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

const network = Network.get('regtest');
const mnemData = require('./data/mnemonic-english.json');

// make wallets addrs deterministic.
const phrases = mnemData.map(d => Mnemonic.fromPhrase(d[1]));

const {
  treeInterval,
  biddingPeriod
  // revealPeriod,
  // transferLockup
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
const ALT_ACCOUNT = 'alt';

// Balances
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

const INIT_BLOCKS = treeInterval;
const INIT_FUND = 10e6;
const NULL_BALANCE = new BalanceObj({
  tx: 0,
  coin: 0,
  unconfirmed: 0,
  confirmed: 0,
  ulocked: 0,
  clocked: 0
});

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

// first is loser if it matters.
const BLIND_AMOUNT_1 = 1e6;
const BID_AMOUNT_1 = BLIND_AMOUNT_1 / 4;
const BLIND_ONLY_1 = BLIND_AMOUNT_1 - BID_AMOUNT_1;

// second is winner.
const BLIND_AMOUNT_2 = 3e6;
const BID_AMOUNT_2 = BLIND_AMOUNT_2 / 4;
const BLIND_ONLY_2 = BLIND_AMOUNT_2 - BID_AMOUNT_2;

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
 * MTX Helpers
 */

function addRevealOutput(mtx, options) {
  const {
    name,
    coin,
    height,
    value,
    nonce
  } = options;

  const nameHash = rules.hashName(name);

  mtx.addOutpoint(coin);

  const output = new Output();
  output.address = options.address ? options.address : coin.getAddress();
  output.value = value;
  output.covenant.type = types.REVEAL;
  output.covenant.pushHash(nameHash);
  output.covenant.pushU32(height);
  output.covenant.pushHash(nonce);

  mtx.addOutput(output);
}

/*
 * Balance helpers
 */

/**
 * @returns {Promise<BalanceObj>}
 */

async function getBalanceObj(wallet, accountName) {
  const balance = await wallet.getBalance(accountName);
  return BalanceObj.fromBalance(balance.getJSON(true));
}

async function assertBalance(wallet, accountName, expected, message) {
  const balance = await getBalanceObj(wallet, accountName);
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
   * @callback BalanceCheckFunction
   * @param {Wallet} wallet
   * @param {Account} account
   * @param {Number} ahead
   * @param {Object} [opts]
   */

  /**
   * @typedef {Object} TestBalances
   * @property {BalanceObj} TestBalances.initialBalance
   * @property {BalanceObj} TestBalances.sentBalance
   * @property {BalanceObj} TestBalances.confirmedBalance
   * @property {BalanceObj} TestBalances.unconfirmedBalance
   * @property {BalanceObj} TestBalances.eraseBalance
   * @property {BalanceObj} TestBalances.blockConfirmedBalance
   * @property {BalanceObj} TestBalances.blockUnconfirmedBalance
   * @property {BalanceObj} [TestBalances.blockFinalConfirmedBalance]
   */

  /**
   * @typedef {Object} CheckFunctions
   * @property {BalanceCheckFunction} CheckFunctions.initCheck
   * @property {BalanceCheckFunction} CheckFunctions.sentCheck
   * @property {BalanceCheckFunction} CheckFunctions.confirmedCheck
   * @property {BalanceCheckFunction} CheckFunctions.unconfirmedCheck
   * @property {BalanceCheckFunction} CheckFunctions.eraseCheck
   * @property {BalanceCheckFunction} CheckFunctions.blockConfirmCheck
   * @property {BalanceCheckFunction} CheckFunctions.blockUnconfirmCheck
   * @property {BalanceCheckFunction} CheckFunctions.blockFinalConfirmCheck
   */

  /**
   * @callback BalanceTestFunction
   * @param {CheckFunctions} checks
   * @param {BalanceCheckFunction} discoverFn
   * @param {DISCOVER_TYPES} discoverAt
   * @param {Object} opts
   */

  /**
   * Supports missing address/discoveries at certain points.
   * @param {BalanceCheckFunction} [setupFn]
   * @param {BalanceCheckFunction} receiveFn
   * @param {Number} ahead
   * @returns {BalanceTestFunction}
   */

  const balanceTest = (setupFn, receiveFn, ahead) => {
    return async (checks, discoverFn, discoverAt, opts = {}) => {
      const {wallet, accountName} = getNextWallet();
      const account = await wallet.getAccount(accountName);

      if (setupFn)
        await setupFn(wallet, account, ahead, opts);

      await checks.initCheck(wallet, account, ahead, opts);

      await receiveFn(wallet, account, ahead, opts);
      await checks.sentCheck(wallet, account, ahead, opts);

      if (discoverAt === DISCOVER_TYPES.BEFORE_CONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      await mineBlocks(1);
      await checks.confirmedCheck(wallet, account, ahead, opts);

      // now unconfirm
      if (discoverAt === DISCOVER_TYPES.BEFORE_UNCONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      await wdb.revert(chain.tip.height - 1);
      await checks.unconfirmedCheck(wallet, account, ahead, opts);

      // now erase
      if (discoverAt === DISCOVER_TYPES.BEFORE_ERASE)
        await discoverFn(wallet, account, ahead, opts);

      await wallet.zap(accountName, 0);
      await checks.eraseCheck(wallet, account, ahead, opts);

      if (discoverAt === DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      // Final look at full picture.
      await wdb.scan(chain.tip.height - 1);
      await checks.blockConfirmCheck(wallet, account, ahead, opts);

      if (discoverAt === DISCOVER_TYPES.BEFORE_BLOCK_UNCONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      // Unconfirm
      await wdb.revert(chain.tip.height - 1);
      await checks.blockUnconfirmCheck(wallet, account, ahead, opts);

      // Clean up wallet.
      await wdb.scan(chain.tip.height - 1);
      await checks.blockFinalConfirmCheck(wallet, account, ahead, opts);
    };
  };

  const BALANCE_CHECK_MAP = {
    initCheck: ['initialBalance', 'Initial'],
    sentCheck: ['sentBalance', 'Sent'],
    confirmedCheck: ['confirmedBalance', 'Confirmed'],
    unconfirmedCheck: ['unconfirmedBalance', 'Unconfirmed'],
    eraseCheck: ['eraseBalance', 'Erase'],
    blockConfirmCheck: ['blockConfirmedBalance', 'Block confirmed'],
    blockUnconfirmCheck: ['blockUnconfirmedBalance', 'Block unconfirmed'],
    blockFinalConfirmCheck: ['blockFinalConfirmedBalance', 'Block final confirmed']
  };

  /**
   * Check against wallet and default account balances.
   * @param {TestBalances} balances
   * @returns {CheckFunctions}
   */

  const defBalanceChecks = (balances) => {
    const checks = {};

    for (const [key, [balanceName, name]] of Object.entries(BALANCE_CHECK_MAP)) {
      checks[key] = async (wallet) => {
        let bname = balanceName;

        if (bname === 'blockFinalConfirmedBalance' && !balances[bname])
          bname = 'blockConfirmedBalance';

        await assertBalance(wallet, DEFAULT_ACCOUNT, balances[bname],
          `${name} balance is incorrect in the account ${DEFAULT_ACCOUNT}.`);

        await assertBalance(wallet, -1, balances[bname],
          `${name} balance is incorrect for the wallet.`);
      };
    }

    return checks;
  };

  /**
   * Check also wallet, default and alt account balances.
   * @param {TestBalances} walletBalances
   * @param {TestBalances} defBalances - default account
   * @param {TestBalances} altBalances - alt account balances
   * @returns {CheckFunctions}
   */

  const checkAllBalances = (walletBalances, defBalances, altBalances) => {
    const checks = {};

    for (const [key, [balanceName, name]] of Object.entries(BALANCE_CHECK_MAP)) {
      checks[key] = async (wallet) => {
        let bname = balanceName;

        if (bname === 'blockFinalConfirmedBalance' && !defBalances[bname])
          bname = 'blockConfirmedBalance';

        await assertBalance(wallet, DEFAULT_ACCOUNT, defBalances[bname],
          `${name} balance is incorrect in the account ${DEFAULT_ACCOUNT}.`);

        await assertBalance(wallet, ALT_ACCOUNT, altBalances[bname],
          `${name} balance is incorrect in the account ${ALT_ACCOUNT}.`);

        await assertBalance(wallet, -1, walletBalances[bname],
          `${name} balance is incorrect for the wallet.`);
      };
    }

    return checks;
  };

  const defDiscover = async (wallet, account, ahead) => {
    await catchUpToAhead(wallet, DEFAULT_ACCOUNT, ahead);
  };

  const altDiscover = async (wallet, account, ahead) => {
    await catchUpToAhead(wallet, ALT_ACCOUNT, ahead);
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
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: SEND_AMOUNT
      });

      balances.unconfirmedBalance = balances.sentBalance;
      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.sentBalance;

      await test(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it('should handle normal receive, discover on confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      // here we discover second coin.
      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        coin: 1,
        confirmed: SEND_AMOUNT * 2,
        unconfirmed: SEND_AMOUNT
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -SEND_AMOUNT * 2
      });

      balances.eraseBalance = balances.initialBalance;

      // We have already derived, so this should discover right away
      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await test(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.BEFORE_CONFIRM
      );
    });

    it('should handle normal receive, discover on unconfirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
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
      balances.blockConfirmedBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        confirmed: SEND_AMOUNT * 2,
        unconfirmed: SEND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        confirmed: -SEND_AMOUNT * 2
      });

      await test(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.BEFORE_UNCONFIRM
      );
    });

    // This is same as discover on block confirm.
    it('should handle normal receive, discover on erase/block confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: SEND_AMOUNT
      });

      balances.unconfirmedBalance = balances.sentBalance;

      // Those credits are gone anyway, so nothing will be added to the balances.
      balances.eraseBalance = balances.initialBalance;

      balances.blockConfirmedBalance = applyDelta(balances.eraseBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: SEND_AMOUNT * 2,
        confirmed: SEND_AMOUNT * 2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        confirmed: -SEND_AMOUNT * 2
      });

      const checks = defBalanceChecks(balances);
      await test(checks, defDiscover, DISCOVER_TYPES.BEFORE_ERASE);
      await test(checks, defDiscover, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
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

    const setupTXFromFuture = async (wallet, account, ahead) => {
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
    const test = balanceTest(setupTXFromFuture, receive, AHEAD);

    it('should spend normal credit (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,
        coin: 1,
        confirmed: SEND_AMOUNT,
        unconfirmed: SEND_AMOUNT
      });

      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: -1,
        unconfirmed: -SEND_AMOUNT
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
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

      balances.blockConfirmedBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: -1,
        confirmed: -SEND_AMOUNT,
        unconfirmed: -SEND_AMOUNT
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        confirmed: SEND_AMOUNT
      });

      await test(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it.skip('should spend credit, discover before confirm', async () => {
      // TODO: Implement with coinview update.
      // This will be no different than normal credit spend if
      // we don't receive CoinView from the chain. So skip this until we
      // have that feature.
    });

    // We don't have any details about inputs, so it's not possible to recover them.
    // it('should spend credit, discover before unconfirm', async () => {});
    // it('should spend credit, discover before erase', async () => {});

    it.skip('should spend credit, discover before block confirm', async () => {
      // This will be no different than normal credit spend if
      // we don't receive CoinView from the chain. So skip this until we
      // have that feature.
    });

    // We don't have any details about inputs, so it's not possible to recover them.
    // it('should spend credit, discover on block unconfirm', async () => { });
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
    const sentBalance = applyDelta(initialBalance, {
      tx: 2,
      coin: 0,
      unconfirmed: 0
    });

    // Nothing changes for confirmed either. (Coins are spent in pending)
    const confirmedBalance = applyDelta(sentBalance, {});
    const unconfirmedBalance = applyDelta(confirmedBalance, {});

    // We no longer have two txs.
    const eraseBalance = applyDelta(unconfirmedBalance, { tx: -2 });
    const blockConfirmedBalance = confirmedBalance;
    const blockUnconfirmedBalance = unconfirmedBalance;

    const balances = {
      initialBalance,
      sentBalance,
      confirmedBalance,
      unconfirmedBalance,
      eraseBalance,
      blockConfirmedBalance,
      blockUnconfirmedBalance
    };

    const checks = defBalanceChecks(balances);

    it('should spend credit (no discovery)', async () => {
      await test(checks, DISCOVER_TYPES.NONE);
    });

    it('should spend credit, discover on confirm', async () => {
      // Here we discover another output on Confirm.
      // But it is spent right away from the next transaction
      // that gets committed. So nothing will actually change.
      await test(checks, DISCOVER_TYPES.BEFORE_CONFIRM);
    });

    it('should spend credit, discover on unconfirm', async () => {
      // Here we don't actually discover output. We could but that
      // is another TODO: Add spent in pending credit discovery.
      // Balance will be the same, but the entries in the database
      // for the coin will be different.
      await test(checks, DISCOVER_TYPES.BEFORE_UNCONFIRM);
    });

    it('should spend credit, discover on erase', async () => {
      // Nothing should happen as outputs go away.. Does not matter
      // if we discover.
      await test(checks, DISCOVER_TYPES.BEFORE_ERASE);
    });

    it('should spend credit, discover on block confirm', async () => {
      // Here we discover the coins, but because they are spent right away
      // it must not change the coin/balance.
      // Test for that is covered above in normal receive.
      await test(checks, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it('should spend credit, discover on block unconfirm', async () => {
      // Same as UNCONFIRM note.
      await test(checks, DISCOVER_TYPES.BEFORE_BLOCK_UNCONFIRM);
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

    const sendOpen = async (wallet) => {
      const name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await wallet.sendOpen(name, false, {
        hardFee: HARD_FEE
      });
    };

    const testOpen = balanceTest(null, sendOpen, 0);

    it('should handle open', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;

      // TODO: This should not introduce new COIN.
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
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

      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testOpen(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });
  });

  describe('NONE -> BID* (normal receive)', function() {
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    const setupBidName = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendNormalBid = async (wallet, account, ahead) => {
      const {nextAddr} = getAheadAddr(account, ahead);
      const txOpts = { hardFee: HARD_FEE };

      const bidMTX = await wallet.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);
      bidMTX.outputs[1].address = nextAddr;

      await resign(wallet, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const testBidReceive = balanceTest(setupBidName, sendNormalBid, AHEAD);

    it('should receive bid (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // We have additional coin because: output -> BID + Change
        // Additional BID is undiscovered.
        coin: 1,
        // Bid we are not aware of is seen as spent.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT_2,
        ulocked: -BLIND_AMOUNT_1
      });

      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testBidReceive(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it('should receive bid, discover on confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // We have additional coin because: output -> BID + Change
        // Additional BID is undiscovered.
        coin: 1,
        // Bid we are not aware of is seen as spent.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        // We discovered another bid is also ours..
        coin: 1,
        // So we add discovered bid back to our balance
        unconfirmed: BLIND_AMOUNT_2,
        // Confirm will only deduce fee.
        confirmed: -HARD_FEE,
        // also add them to the unconfirmed locks.
        ulocked: BLIND_AMOUNT_2,
        // We lock both in confirmed.
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      // Now everything flows as if we have received both at once.
      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -2,
        unconfirmed: HARD_FEE,
        ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testBidReceive(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.BEFORE_CONFIRM
      );
    });

    it('should receive bid, discover on unconfirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1
      });

      // TODO: Unconfirm updates to the balance
      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1
      });

      // TODO: Unconfirm balance update.
      // TODO: This after unconfirm discovery should be:
      // balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
      //   // revert confirmed
      //   confirmed: HARD_FEE + BLIND_AMOUNT_2,
      //   // nothing is clocked.
      //   clocked: -BLIND_AMOUNT_1,

      //   // we now count newly discovered bid to the balance.
      //   unconfirmed: BLIND_AMOUNT_2,
      //   // we also ulock that amount
      //   ulocked: BLIND_AMOUNT_2,
      //   // new bid is our coin.
      //   coin: 1
      // });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT_2,
        ulocked: -BLIND_AMOUNT_1
      });

      // Insert(block) recovers balance.
      balances.blockConfirmedBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: -HARD_FEE,
        confirmed: -HARD_FEE,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2,
        confirmed: HARD_FEE
      });

      await testBidReceive(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.BEFORE_UNCONFIRM
      );
    });

    // this should be same as discover on block confirm.
    it('should receive bid, discover on erase/block confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT_2,
        ulocked: -BLIND_AMOUNT_1
      });

      // Start from init balance
      balances.blockConfirmedBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: -HARD_FEE,
        confirmed: -HARD_FEE,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        confirmed: HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      const checks = defBalanceChecks(balances);
      await testBidReceive(checks, defDiscover, DISCOVER_TYPES.BEFORE_ERASE);
      await testBidReceive(checks, defDiscover, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it('should receive bid, discover on block unconfirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 1,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1
      });

      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE + BLIND_AMOUNT_2,
        ulocked: -BLIND_AMOUNT_1
      });

      // Insert(block) recovers balance.
      balances.blockConfirmedBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: -HARD_FEE,
        confirmed: -HARD_FEE,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      // TODO: Unconfirm balance update.
      // TODO: This after unconfirm discovery should be:
      // balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
      //   // revert confirmed
      //   confirmed: HARD_FEE + BLIND_AMOUNT_2,
      //   // nothing is clocked.
      //   clocked: -BLIND_AMOUNT_1,

      //   // we now count newly discovered bid to the balance.
      //   unconfirmed: BLIND_AMOUNT_2,
      //   // we also ulock that amount
      //   ulocked: BLIND_AMOUNT_2,
      //   // new bid is our coin.
      //   coin: 1
      // });
      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2,
        confirmed: HARD_FEE
      });

      await testBidReceive(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.BEFORE_UNCONFIRM
      );
    });
  });

  describe('NONE -> BID* (foreign bid)', function() {
    before(() => {
      genWallets = 4;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    const setupBidName = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendForeignBid = async (wallet, account, ahead) => {
      const recvAddr = await wallet.receiveAddress();
      const {nextAddr} = getAheadAddr(account, ahead);
      const txOpts = { hardFee: HARD_FEE };

      const bidMTX = await primary.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
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
    const testForeign = balanceTest(setupBidName, sendForeignBid, AHEAD);

    it('should receive foreign bid (no discovery)', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: BLIND_AMOUNT_1,
        clocked: BLIND_AMOUNT_1
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT_1,
        clocked: -BLIND_AMOUNT_1
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.sentBalance;

      await testForeign(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it('should receive foreign bid, discover on confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // here we discover another coin
      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        coin: 1,
        unconfirmed: BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_2,

        confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testForeign(
        defBalanceChecks(balances),
        defDiscover,
        DISCOVER_TYPES.BEFORE_CONFIRM
      );
    });

    it.skip('should receive foreign bid, discover on unconfirm', async () => {});

    it('should receive foreign bid, discover on erase/block confirm', async () => {
      const balances = {};
      balances.initialBalance = INIT_BALANCE;
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // only BID
        coin: 1,
        // We did not own this money before
        unconfirmed: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: BLIND_AMOUNT_1,
        clocked: BLIND_AMOUNT_1
      });

      balances.unconfirmedBalance = applyDelta(balances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT_1,
        clocked: -BLIND_AMOUNT_1
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmedBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        coin: 2,
        unconfirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        confirmed: BLIND_AMOU2451ggNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      balances.blockUnconfirmedBalance = applyDelta(balances.blockConfirmedBalance, {
        confirmed: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      const checks = defBalanceChecks(balances);
      await testForeign(checks, defDiscover, DISCOVER_TYPES.BEFORE_ERASE);
      await testForeign(checks, defDiscover, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it.skip('should receive foreign bid, discover block unconfirm', async () => {});
  });

  describe('NONE -> BID* (cross acct)', function() {
    before(() => {
      genWallets = 4;
      return beforeAll();
    });

    after(afterAll);

    let name;
    const setupAcctAndBidName = async (wallet) => {
      await wallet.createAccount({
        name: ALT_ACCOUNT
      });

      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
    };

    const sendCrossAcct = async (wallet, account, ahead) => {
      const txOpts = { hardFee: HARD_FEE };
      const altAccount = await wallet.getAccount(ALT_ACCOUNT);

      // not actually next, we test normal recive.
      const addr1 = getAheadAddr(altAccount, -altAccount.lookahead);
      const addr2 = getAheadAddr(altAccount, ahead);

      const bidMTX = await wallet.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);

      bidMTX.outputs[0].address = addr1.nextAddr;
      // future tx.
      bidMTX.outputs[1].address = addr2.nextAddr;

      await resign(wallet, bidMTX);
      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
    };

    const AHEAD = 10;
    const testCrossAcctBalance = balanceTest(setupAcctAndBidName, sendCrossAcct, AHEAD);

    it('should send/receive bid cross acct (no discovery)', async () => {
      const walletBalances = {};
      const defBalances = {};
      const altBalances = {};

      walletBalances.initialBalance = INIT_BALANCE;
      defBalances.initialBalance = INIT_BALANCE;
      altBalances.initialBalance = NULL_BALANCE;

      // sent from default to alt, default account does not lock
      defBalances.sentBalance = applyDelta(defBalances.initialBalance, {
        tx: 1,
        // output -> change output + 2 BIDs to alt
        coin: 0,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      // alt account balance locks unconfirmed and receives coin.
      altBalances.sentBalance = applyDelta(altBalances.initialBalance, {
        tx: 1,
        // received BID + missed BID.
        coin: 1,
        unconfirmed: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // Wallet only spends FEE
      walletBalances.sentBalance = applyDelta(walletBalances.initialBalance, {
        tx: 1,
        // Total coins is: output -> BID output + CHANGE + Undiscovered BID
        coin: 1,
        // for now another bid just out transaction.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      // NOW CONFIRM
      defBalances.confirmedBalance = applyDelta(defBalances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.confirmedBalance = applyDelta(altBalances.sentBalance, {
        confirmed: BLIND_AMOUNT_1,
        clocked: BLIND_AMOUNT_1
      });

      walletBalances.confirmedBalance = applyDelta(walletBalances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1
      });

      // NOW Unconfirm again
      defBalances.unconfirmedBalance = applyDelta(defBalances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      altBalances.unconfirmedBalance = applyDelta(altBalances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT_1,
        clocked: -BLIND_AMOUNT_1
      });

      walletBalances.unconfirmedBalance = applyDelta(walletBalances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1
      });

      // NOW Erase
      walletBalances.eraseBalance = walletBalances.initialBalance;
      defBalances.eraseBalance = defBalances.initialBalance;
      altBalances.eraseBalance = altBalances.initialBalance;

      walletBalances.blockConfirmedBalance = walletBalances.confirmedBalance;
      defBalances.blockConfirmedBalance = defBalances.confirmedBalance;
      altBalances.blockConfirmedBalance = altBalances.confirmedBalance;

      walletBalances.blockUnconfirmedBalance = walletBalances.unconfirmedBalance;
      defBalances.blockUnconfirmedBalance = defBalances.unconfirmedBalance;
      altBalances.blockUnconfirmedBalance = altBalances.unconfirmedBalance;

      await testCrossAcctBalance(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it('should send/receive bid cross acct, discover on confirm', async () => {
      const walletBalances = {};
      const defBalances = {};
      const altBalances = {};

      walletBalances.initialBalance = INIT_BALANCE;
      defBalances.initialBalance = INIT_BALANCE;
      altBalances.initialBalance = NULL_BALANCE;

      // sent from default to alt, default account does not lock
      defBalances.sentBalance = applyDelta(defBalances.initialBalance, {
        tx: 1,
        // output -> change output + 2 BIDs to alt
        coin: 0,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      // alt account balance locks unconfirmed and receives coin.
      altBalances.sentBalance = applyDelta(altBalances.initialBalance, {
        tx: 1,
        // received BID + missed BID.
        coin: 1,
        unconfirmed: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // Wallet only spends FEE
      walletBalances.sentBalance = applyDelta(walletBalances.initialBalance, {
        tx: 1,
        // Total coins is: output -> BID output + CHANGE + Undiscovered BID
        coin: 1,
        // for now another bid is just out transaction.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      // NOW CONFIRM - We Discover
      defBalances.confirmedBalance = applyDelta(defBalances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.confirmedBalance = applyDelta(altBalances.sentBalance, {
        coin: 1,
        confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        unconfirmed: BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_2
      });

      // account for newly discover locks
      walletBalances.confirmedBalance = applyDelta(walletBalances.sentBalance, {
        coin: 1,
        unconfirmed: BLIND_AMOUNT_2,
        confirmed: -HARD_FEE,

        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_2
      });

      // NOW Unconfirm again
      defBalances.unconfirmedBalance = applyDelta(defBalances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      altBalances.unconfirmedBalance = applyDelta(altBalances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      walletBalances.unconfirmedBalance = applyDelta(walletBalances.confirmedBalance, {
        confirmed: HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      // NOW Erase
      walletBalances.eraseBalance = walletBalances.initialBalance;
      defBalances.eraseBalance = defBalances.initialBalance;
      altBalances.eraseBalance = altBalances.initialBalance;

      walletBalances.blockConfirmedBalance = walletBalances.confirmedBalance;
      defBalances.blockConfirmedBalance = defBalances.confirmedBalance;
      altBalances.blockConfirmedBalance = altBalances.confirmedBalance;

      walletBalances.blockUnconfirmedBalance = walletBalances.unconfirmedBalance;
      defBalances.blockUnconfirmedBalance = defBalances.unconfirmedBalance;
      altBalances.blockUnconfirmedBalance = altBalances.unconfirmedBalance;

      await testCrossAcctBalance(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.BEFORE_CONFIRM
      );
    });

    it.skip('should send/receive bid cross acct, discover on unconfirm', async () => {});

    it('should send/receive bid cross act, discover on erase/block confirm', async () => {
      const walletBalances = {};
      const defBalances = {};
      const altBalances = {};

      walletBalances.initialBalance = INIT_BALANCE;
      defBalances.initialBalance = INIT_BALANCE;
      altBalances.initialBalance = NULL_BALANCE;

      // sent from default to alt, default account does not lock
      defBalances.sentBalance = applyDelta(defBalances.initialBalance, {
        tx: 1,
        // output -> change output + 2 BIDs to alt
        coin: 0,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      // alt account balance locks unconfirmed and receives coin.
      altBalances.sentBalance = applyDelta(altBalances.initialBalance, {
        tx: 1,
        // received BID + missed BID.
        coin: 1,
        unconfirmed: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // Wallet only spends FEE
      walletBalances.sentBalance = applyDelta(walletBalances.initialBalance, {
        tx: 1,
        // Total coins is: output -> BID output + CHANGE + Undiscovered BID
        coin: 1,
        // for now another bid just out transaction.
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1
      });

      // NOW CONFIRM
      defBalances.confirmedBalance = applyDelta(defBalances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.confirmedBalance = applyDelta(altBalances.sentBalance, {
        confirmed: BLIND_AMOUNT_1,
        clocked: BLIND_AMOUNT_1
      });

      walletBalances.confirmedBalance = applyDelta(walletBalances.sentBalance, {
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1
      });

      // NOW Unconfirm again
      defBalances.unconfirmedBalance = applyDelta(defBalances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      altBalances.unconfirmedBalance = applyDelta(altBalances.confirmedBalance, {
        confirmed: -BLIND_AMOUNT_1,
        clocked: -BLIND_AMOUNT_1
      });

      walletBalances.unconfirmedBalance = applyDelta(walletBalances.confirmedBalance, {
        confirmed: HARD_FEE + BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1
      });

      // NOW Erase
      walletBalances.eraseBalance = walletBalances.initialBalance;
      defBalances.eraseBalance = defBalances.initialBalance;
      altBalances.eraseBalance = altBalances.initialBalance;

      // Now we are aware of the output.
      walletBalances.blockConfirmedBalance = applyDelta(walletBalances.eraseBalance, {
        tx: 1,
        // output -> BID + BID + CHANGE
        coin: 2,

        confirmed: -HARD_FEE,
        unconfirmed: -HARD_FEE,

        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });
      // Def balance does not change
      defBalances.blockConfirmedBalance = defBalances.confirmedBalance;
      altBalances.blockConfirmedBalance = applyDelta(altBalances.eraseBalance, {
        tx: 1,
        coin: 2,

        confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        unconfirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      walletBalances.blockUnconfirmedBalance = applyDelta(walletBalances.blockConfirmedBalance, {
        confirmed: HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      defBalances.blockUnconfirmedBalance = defBalances.unconfirmedBalance;
      altBalances.blockUnconfirmedBalance = applyDelta(altBalances.blockConfirmedBalance, {
        confirmed: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      await testCrossAcctBalance(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.BEFORE_ERASE
      );
      await testCrossAcctBalance(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM
      );
    });

    it.skip('should send/receive bid cross act, discover on block unconfirm', async () => {});
  });

  describe('BID* -> REVEAL*', function() {
    before(() => {
      genWallets = 4;
      return beforeAll();
    });

    after(afterAll);

    let name = null;
    let receiveKey = null;
    let height = 0;
    let coins = [];
    let blinds = [];

    const setupRevealName = async (wallet, account, ahead) => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);
      const txOpts = { hardFee: HARD_FEE };
      const next = getAheadAddr(account, ahead, wallet.master);
      const {nextAddr} = next;
      receiveKey = next.receiveKey;

      await primary.sendOpen(name, false);
      height = chain.tip.height + 1;
      await mineBlocks(openingPeriod);

      const bidMTX = await wallet.createBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);

      assert.strictEqual(bidMTX.outputs[0].covenant.type, types.BID);
      assert.strictEqual(bidMTX.outputs[1].covenant.type, types.BID);
      bidMTX.outputs[1].address = nextAddr;

      await resign(wallet, bidMTX);

      coins = [
        Coin.fromTX(bidMTX, 0, chain.tip.height + 1),
        Coin.fromTX(bidMTX, 1, chain.tip.height + 1)
      ];

      blinds = [
        bidMTX.outputs[0].covenant.getHash(3),
        bidMTX.outputs[1].covenant.getHash(3)
      ];

      node.mempool.addTX(bidMTX.toTX());
      await forWTX(wallet.id, bidMTX.hash());
      await mineBlocks(biddingPeriod);
    };

    const sendReveal = async (wallet, account, ahead) => {
      const mtx = new MTX();

      const nonces = [
        (await wallet.getBlind(blinds[0])).nonce,
        (await wallet.getBlind(blinds[1])).nonce
      ];

      addRevealOutput(mtx, {
        name,
        height,
        coin: coins[0],
        value: BID_AMOUNT_1,
        nonce: nonces[0]
      });

      addRevealOutput(mtx, {
        name,
        height,
        coin: coins[1],
        value: BID_AMOUNT_2,
        nonce: nonces[1]
      });

      await mtx.fund(coins, {
        hardFee: HARD_FEE,
        changeAddress: await account.changeAddress()
      });

      await wallet.sign(mtx);
      await mtx.signAsync(receiveKey);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const testReveal = balanceTest(setupRevealName, sendReveal, AHEAD);

    it('should send/receive reveal (no discovery)', async () => {
      const balances = {};

      balances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,
        // out = BID + Unknown BID + CHANGE
        coin: 1,

        // one bid is unknown
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,

        // one bid is unknown
        clocked: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // Now we receive REVEAL - which frees BLIND and only locks bid amount.
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // extra coin from Change
        coin: 1,
        // We recover BLIND_ONLY from the unknown BID via change.
        unconfirmed: BLIND_ONLY_2 - HARD_FEE,
        ulocked: -BLIND_ONLY_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: BLIND_ONLY_2 - HARD_FEE,
        clocked: -BLIND_ONLY_1
      });

      balances.unconfirmedBalance = balances.sentBalance;
      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testReveal(defBalanceChecks(balances), defDiscover, DISCOVER_TYPES.NONE);
    });

    it('should send/receive reveal, discover on confirm', async () => {
      const balances = {};

      balances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,
        // out = BID + Unknown BID + CHANGE
        coin: 1,

        // one bid is unknown
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,

        // one bid is unknown
        clocked: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // Now we receive REVEAL - which frees BLIND and only locks bid amount.
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // extra coin from Change
        coin: 1,
        // We recover BLIND_ONLY from the unknown BID via change.
        unconfirmed: BLIND_ONLY_2 - HARD_FEE,
        ulocked: -BLIND_ONLY_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        // Here we discover that another REVEAL is ours.
        coin: 1,

        // We have recovered BLIND_ONLY via change, only thing that is left
        // is BID_AMOUNT.
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2,

        // Recover full amount
        confirmed: BLIND_AMOUNT_2 - HARD_FEE,

        // We remove BLIND_ONLY from the previously BLIND_AMOUNT locked
        // and add newly discovered BID_AMOUNT on top.
        clocked: -BLIND_ONLY_1 + BID_AMOUNT_2
      });

      // Now we know BOTH REVEALS.
      // from previous unconfirmed balance diff.
      balances.unconfirmedBalance = applyDelta(balances.sentBalance, {
        coin: 1,
        // we have already recovered BLIND_ONLY part.
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });

      balances.eraseBalance = balances.initialBalance;
      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testReveal(defBalanceChecks(balances), defDiscover, DISCOVER_TYPES.BEFORE_CONFIRM);
    });

    it.skip('should send/receive reveal, discover on unconfirm', async () => {});

    it('should send/receive reveal, discover on erase/block confirm', async () => {
      const balances = {};

      balances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,
        // out = BID + Unknown BID + CHANGE
        coin: 1,

        // one bid is unknown
        confirmed: -HARD_FEE - BLIND_AMOUNT_2,
        unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,

        // one bid is unknown
        clocked: BLIND_AMOUNT_1,
        ulocked: BLIND_AMOUNT_1
      });

      // Now we receive REVEAL - which frees BLIND and only locks bid amount.
      balances.sentBalance = applyDelta(balances.initialBalance, {
        tx: 1,
        // extra coin from Change
        coin: 1,
        // We recover BLIND_ONLY from the unknown BID via change.
        unconfirmed: BLIND_ONLY_2 - HARD_FEE,
        ulocked: -BLIND_ONLY_1
      });

      balances.confirmedBalance = applyDelta(balances.sentBalance, {
        confirmed: BLIND_ONLY_2 - HARD_FEE,
        clocked: -BLIND_ONLY_1
      });

      balances.unconfirmedBalance = balances.sentBalance;
      balances.eraseBalance = balances.initialBalance;

      // Only here we know that second reveal is also ours.
      // Show the diff from confirmed balance perspective.
      balances.blockConfirmedBalance = applyDelta(balances.confirmedBalance, {
        coin: 1,

        // we have already recovered BLIND_ONLY part from change.
        confirmed: BID_AMOUNT_2,
        clocked: BID_AMOUNT_2,

        // unconfirmed same
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });

      // From the previous unconfirmed perspective
      balances.blockUnconfirmedBalance = applyDelta(balances.unconfirmedBalance, {
        coin: 1,

        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });

      await testReveal(defBalanceChecks(balances), defDiscover, DISCOVER_TYPES.BEFORE_ERASE);
      await testReveal(defBalanceChecks(balances), defDiscover, DISCOVER_TYPES.BEFORE_BLOCK_CONFIRM);
    });

    it.skip('should send/receive reveal, discover on block unconfirm', async () => {});
  });

  describe.only('BID* -> REVEAL* (cross acct)', function() {
    before(() => {
      genWallets = 4;
      return beforeAll();
    });

    after(afterAll);

    let name;

    // This will create BID tx in the first account.
    // two bids belong to the default account.
    const setupRevealName = async (wallet) => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await wallet.createAccount({
        name: ALT_ACCOUNT
      });
      const txOpts = { hardFee: HARD_FEE };

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);

      await wallet.sendBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ], txOpts);
      await mineBlocks(biddingPeriod);
    };

    // Now we sent two REVEALs to second account (one seen, one missed)
    const sendReveal = async (wallet, account, ahead) => {
      const altAccount = await wallet.getAccount(ALT_ACCOUNT);
      const recv = getAheadAddr(altAccount, -altAccount.lookahead);
      const next = getAheadAddr(altAccount, ahead);

      const revealMTX = await wallet.createReveal(name, {
        hardFee: HARD_FEE
      });
      assert.strictEqual(revealMTX.outputs[0].covenant.type, types.REVEAL);
      assert.strictEqual(revealMTX.outputs[1].covenant.type, types.REVEAL);
      revealMTX.outputs[0].address = recv.nextAddr;
      revealMTX.outputs[1].address = next.nextAddr;

      await resign(wallet, revealMTX);
      node.mempool.addTX(revealMTX.toTX());
      await forWTX(wallet.id, revealMTX.hash());
    };

    const AHEAD = 10;
    const testCrossActReveal = balanceTest(setupRevealName, sendReveal, AHEAD);

    it('should send/receive reveal (no discovery)', async () => {
      const walletBalances = {};
      const defBalances = {};
      const altBalances = {};

      // we start with BID transaction
      walletBalances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,

        // we have two bids at the start.
        coin: 2,

        confirmed: -HARD_FEE,
        unconfirmed: -HARD_FEE,

        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      // same as wallet at this stage.
      defBalances.initialBalance = walletBalances.initialBalance;
      // empty at the start.
      altBalances.initialBalance = NULL_BALANCE;

      // After REVEAL Transaction
      walletBalances.sentBalance = applyDelta(walletBalances.initialBalance, {
        tx: 1,
        // extra coin from change.
        // but one reveal becomes missed.
        coin: 0,

        // We only lose reveal amount, diff is going into our change
        unconfirmed: -BID_AMOUNT_2 - HARD_FEE,
        // We also unlock missed bid->reveal,
        // but totally unlock missed one.
        ulocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
      });

      // does not change
      defBalances.sentBalance = applyDelta(defBalances.initialBalance, {
        tx: 1,
        // 2 BIDS -> 1 Change + out 2 reveals
        coin: -1,

        unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
        ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.sentBalance = applyDelta(altBalances.initialBalance, {
        tx: 1,
        // we received 1 reveal (another is unknown)
        coin: 1,

        unconfirmed: BID_AMOUNT_1,
        ulocked: BID_AMOUNT_1
      });

      // Now we confirm everything seen above.
      walletBalances.confirmedBalance = applyDelta(walletBalances.sentBalance, {
        confirmed: -BID_AMOUNT_2 - HARD_FEE,
        clocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
      });

      defBalances.confirmedBalance = applyDelta(defBalances.sentBalance, {
        confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.confirmedBalance = applyDelta(altBalances.sentBalance, {
        confirmed: BID_AMOUNT_1,
        clocked: BID_AMOUNT_1
      });

      // Now we unconfirm everything..
      walletBalances.unconfirmedBalance = walletBalances.sentBalance;
      defBalances.unconfirmedBalance = defBalances.sentBalance;
      altBalances.unconfirmedBalance = altBalances.sentBalance;

      // Erase
      walletBalances.eraseBalance = walletBalances.initialBalance;
      defBalances.eraseBalance = defBalances.initialBalance;
      altBalances.eraseBalance = altBalances.initialBalance;

      // Confirm in block
      walletBalances.blockConfirmedBalance = walletBalances.confirmedBalance;
      defBalances.blockConfirmedBalance = defBalances.confirmedBalance;
      altBalances.blockConfirmedBalance = altBalances.confirmedBalance;

      // Unconfirm in block
      walletBalances.blockUnconfirmedBalance = walletBalances.unconfirmedBalance;
      defBalances.blockUnconfirmedBalance = defBalances.unconfirmedBalance;
      altBalances.blockUnconfirmedBalance = altBalances.unconfirmedBalance;

      await testCrossActReveal(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.NONE
      );
    });

    it('should send/receive reveal, discover on confirm', async () => {
      const walletBalances = {};
      const defBalances = {};
      const altBalances = {};

      // we start with BID transaction
      walletBalances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,

        // we have two bids at the start.
        coin: 2,

        confirmed: -HARD_FEE,
        unconfirmed: -HARD_FEE,

        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      // same as wallet at this stage.
      defBalances.initialBalance = walletBalances.initialBalance;
      // empty at the start.
      altBalances.initialBalance = NULL_BALANCE;

      // After REVEAL Transaction
      walletBalances.sentBalance = applyDelta(walletBalances.initialBalance, {
        tx: 1,
        // extra coin from change.
        // but one reveal becomes missed.
        coin: 0,

        // We only lose reveal amount, diff is going into our change
        unconfirmed: -BID_AMOUNT_2 - HARD_FEE,
        // We also unlock missed bid->reveal,
        // but totally unlock missed one.
        ulocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
      });

      // does not change
      defBalances.sentBalance = applyDelta(defBalances.initialBalance, {
        tx: 1,
        // 2 BIDS -> 1 Change + out 2 reveals
        coin: -1,

        unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
        ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.sentBalance = applyDelta(altBalances.initialBalance, {
        tx: 1,
        // we received 1 reveal (another is unknown)
        coin: 1,

        unconfirmed: BID_AMOUNT_1,
        ulocked: BID_AMOUNT_1
      });

      // Now we confirm everything seen above.
      // WE DISCOVER Another reveal was also ours
      walletBalances.confirmedBalance = applyDelta(walletBalances.sentBalance, {
        coin: 1,
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2,

        confirmed: -HARD_FEE,
        clocked: -BLIND_ONLY_1 - BLIND_ONLY_2
      });

      defBalances.confirmedBalance = applyDelta(defBalances.sentBalance, {
        confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.confirmedBalance = applyDelta(altBalances.sentBalance, {
        coin: 1,
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2,

        confirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
        clocked: BID_AMOUNT_1 + BID_AMOUNT_2
      });

      // Now we unconfirm everything..
      walletBalances.unconfirmedBalance = applyDelta(walletBalances.sentBalance, {
        coin: 1,
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });
      defBalances.unconfirmedBalance = defBalances.sentBalance;
      altBalances.unconfirmedBalance = applyDelta(altBalances.sentBalance, {
        coin: 1,
        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });

      // Erase
      walletBalances.eraseBalance = walletBalances.initialBalance;
      defBalances.eraseBalance = defBalances.initialBalance;
      altBalances.eraseBalance = altBalances.initialBalance;

      // Confirm in block
      walletBalances.blockConfirmedBalance = walletBalances.confirmedBalance;
      defBalances.blockConfirmedBalance = defBalances.confirmedBalance;
      altBalances.blockConfirmedBalance = altBalances.confirmedBalance;

      // Unconfirm in block
      walletBalances.blockUnconfirmedBalance = walletBalances.unconfirmedBalance;
      defBalances.blockUnconfirmedBalance = defBalances.unconfirmedBalance;
      altBalances.blockUnconfirmedBalance = altBalances.unconfirmedBalance;

      await testCrossActReveal(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.BEFORE_CONFIRM
      );
    });

    it.skip('should send/receive reveal, discover on unconfirm', async () => {
    });

    it('should send/receive reveal, discover on erase/block confirm', async () => {
      const walletBalances = {};
      const defBalances = {};
      const altBalances = {};

      // we start with BID transaction
      walletBalances.initialBalance = applyDelta(INIT_BALANCE, {
        tx: 1,

        // we have two bids at the start.
        coin: 2,

        confirmed: -HARD_FEE,
        unconfirmed: -HARD_FEE,

        clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
        ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
      });

      // same as wallet at this stage.
      defBalances.initialBalance = walletBalances.initialBalance;
      // empty at the start.
      altBalances.initialBalance = NULL_BALANCE;

      // After REVEAL Transaction
      walletBalances.sentBalance = applyDelta(walletBalances.initialBalance, {
        tx: 1,
        // extra coin from change.
        // but one reveal becomes missed.
        coin: 0,

        // We only lose reveal amount, diff is going into our change
        unconfirmed: -BID_AMOUNT_2 - HARD_FEE,
        // We also unlock missed bid->reveal,
        // but totally unlock missed one.
        ulocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
      });

      // does not change
      defBalances.sentBalance = applyDelta(defBalances.initialBalance, {
        tx: 1,
        // 2 BIDS -> 1 Change + out 2 reveals
        coin: -1,

        unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
        ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.sentBalance = applyDelta(altBalances.initialBalance, {
        tx: 1,
        // we received 1 reveal (another is unknown)
        coin: 1,

        unconfirmed: BID_AMOUNT_1,
        ulocked: BID_AMOUNT_1
      });

      // Now we confirm everything seen above.
      walletBalances.confirmedBalance = applyDelta(walletBalances.sentBalance, {
        confirmed: -BID_AMOUNT_2 - HARD_FEE,
        clocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
      });

      defBalances.confirmedBalance = applyDelta(defBalances.sentBalance, {
        confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
        clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
      });

      altBalances.confirmedBalance = applyDelta(altBalances.sentBalance, {
        confirmed: BID_AMOUNT_1,
        clocked: BID_AMOUNT_1
      });

      // Now we unconfirm everything..
      walletBalances.unconfirmedBalance = walletBalances.sentBalance;
      defBalances.unconfirmedBalance = defBalances.sentBalance;
      altBalances.unconfirmedBalance = altBalances.sentBalance;

      // Erase
      walletBalances.eraseBalance = walletBalances.initialBalance;
      defBalances.eraseBalance = defBalances.initialBalance;
      altBalances.eraseBalance = altBalances.initialBalance;

      // Confirm in block
      walletBalances.blockConfirmedBalance = applyDelta(walletBalances.confirmedBalance, {
        coin: 1,

        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2,

        confirmed: BID_AMOUNT_2,
        clocked: BID_AMOUNT_2
      });
      defBalances.blockConfirmedBalance = defBalances.confirmedBalance;
      altBalances.blockConfirmedBalance = applyDelta(altBalances.confirmedBalance, {
        coin: 1,

        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2,
        confirmed: BID_AMOUNT_2,
        clocked: BID_AMOUNT_2
      });

      // Unconfirm in block
      walletBalances.blockUnconfirmedBalance = applyDelta(walletBalances.unconfirmedBalance, {
        coin: 1,

        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });
      defBalances.blockUnconfirmedBalance = defBalances.unconfirmedBalance;
      altBalances.blockUnconfirmedBalance = applyDelta(altBalances.unconfirmedBalance, {
        coin: 1,

        unconfirmed: BID_AMOUNT_2,
        ulocked: BID_AMOUNT_2
      });

      await testCrossActReveal(
        checkAllBalances(walletBalances, defBalances, altBalances),
        altDiscover,
        DISCOVER_TYPES.BEFORE_ERASE
      );
    });

    it.skip('should send/receive reveal, discover on block unconfirm', async () => {
    });
  });

});
