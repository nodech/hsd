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

const {
  NONE,
  BEFORE_CONFIRM,
  BEFORE_UNCONFIRM,
  BEFORE_ERASE,
  BEFORE_BLOCK_CONFIRM,
  BEFORE_BLOCK_UNCONFIRM
} = DISCOVER_TYPES;

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
const SEND_AMOUNT_2 = 3e6;

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

      if (discoverAt === BEFORE_CONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      await mineBlocks(1);
      await checks.confirmedCheck(wallet, account, ahead, opts);

      // now unconfirm
      if (discoverAt === BEFORE_UNCONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      await wdb.revert(chain.tip.height - 1);
      await checks.unconfirmedCheck(wallet, account, ahead, opts);

      // now erase
      if (discoverAt === BEFORE_ERASE)
        await discoverFn(wallet, account, ahead, opts);

      await wallet.zap(accountName, 0);
      await checks.eraseCheck(wallet, account, ahead, opts);

      if (discoverAt === BEFORE_BLOCK_CONFIRM)
        await discoverFn(wallet, account, ahead, opts);

      // Final look at full picture.
      await wdb.scan(chain.tip.height - 1);
      await checks.blockConfirmCheck(wallet, account, ahead, opts);

      if (discoverAt === BEFORE_BLOCK_UNCONFIRM)
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
   * Check also wallet, default and alt account balances.
   * @param {TestBalances} walletBalances
   * @param {TestBalances} [defBalances] - default account
   * @param {TestBalances} [altBalances] - alt account balances
   * @returns {CheckFunctions}
   */

  const checkBalances = (walletBalances, defBalances, altBalances) => {
    const checks = {};

    if (defBalances == null)
      defBalances = walletBalances;

    for (const [key, [balanceName, name]] of Object.entries(BALANCE_CHECK_MAP)) {
      checks[key] = async (wallet) => {
        let bname = balanceName;

        if (bname === 'blockFinalConfirmedBalance' && !defBalances[bname])
          bname = 'blockConfirmedBalance';

        await assertBalance(wallet, DEFAULT_ACCOUNT, defBalances[bname],
          `${name} balance is incorrect in the account ${DEFAULT_ACCOUNT}.`);

        if (altBalances != null) {
          await assertBalance(wallet, ALT_ACCOUNT, altBalances[bname],
            `${name} balance is incorrect in the account ${ALT_ACCOUNT}.`);
        }

        await assertBalance(wallet, -1, walletBalances[bname],
          `${name} balance is incorrect for the wallet.`);
      };
    }

    return checks;
  };

  const combineBalances = (undiscovered, discovered, discoverAt) => {
    if (Array.isArray(undiscovered) && Array.isArray(discovered)) {
      const combined = [];

      for (let i = 0; i < undiscovered.length; i++)
        combined.push(combineBalances(undiscovered[i], discovered[i], discoverAt));

      return combined;
    }

    const balances = { ...undiscovered };

    switch (discoverAt) {
      case BEFORE_CONFIRM: {
        balances.confirmedBalance = discovered.confirmedBalance;

        // TODO: After unconfirm detection, remove next line.
        balances.unconfirmedBalance = discovered.unconfirmedBalance;
      }

      case BEFORE_UNCONFIRM: {
        // TODO: After unconfirm detection, uncomment next line.
        // balances.unconfirmedBalance = discovered.unconfirmedBalance;
      }

      case BEFORE_ERASE:
      case BEFORE_BLOCK_CONFIRM: {
        balances.blockConfirmedBalance = discovered.blockConfirmedBalance;

        // TODO: After unconfirm detection, remove next line.
        balances.blockUnconfirmedBalance = discovered.blockUnconfirmedBalance;
      }

      case BEFORE_BLOCK_UNCONFIRM: {
        // TODO: After unconfirm detection, uncomment next line.
        // balances.blockUnconfirmedBalance = undiscovered.blockUnconfirmedBalance;
        balances.blockFinalConfirmedBalance = discovered.blockConfirmedBalance;
      }

      case NONE:
      default:
    }

    return balances;
  };

  const defDiscover = async (wallet, account, ahead) => {
    await catchUpToAhead(wallet, DEFAULT_ACCOUNT, ahead);
  };

  const altDiscover = async (wallet, account, ahead) => {
    await catchUpToAhead(wallet, ALT_ACCOUNT, ahead);
  };

  const genTests = (options) => {
    const {
      name,
      undiscovered,
      discovered,
      tester,
      checker,
      discoverer
    } = options;

    const genTestBody = (type) => {
      // three balances including alt are different.
      if (Array.isArray(undiscovered)) {
        return async () => {
          const balances = combineBalances(undiscovered, discovered, type);
          await tester(checker(balances[0], balances[1], balances[2]), discoverer, type);
        };
      }
      return async () => {
        const balances = combineBalances(undiscovered, discovered, type);
        await tester(checker(balances), discoverer, type);
      };
    };

    it(`${name} (no discovery)`, genTestBody(NONE));
    it(`${name}, discover on confirm`, genTestBody(BEFORE_CONFIRM));
    it(`${name}, discover on unconfirm`, genTestBody(BEFORE_UNCONFIRM));
    it(`${name}, discover on erase`, genTestBody(BEFORE_ERASE));
    it(`${name}, discover on block confirm`, genTestBody(BEFORE_CONFIRM));
    it(`${name}, discover on block unconfirm`, genTestBody(BEFORE_ERASE));
  };

  describe('NONE -> NONE* (normal receive)', function() {
    before(() => {
      genWallets = 6;
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
          value: SEND_AMOUNT_2
        }]
      });
    };

    // account.lookahead + AHEAD
    const AHEAD = 10;
    const testReceive = balanceTest(null, receive, AHEAD);

    // Balances if we did not discover
    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: 1,
      unconfirmed: SEND_AMOUNT
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: SEND_AMOUNT
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.sentBalance;

    // Balances if we discovered from the beginning
    const DISCOVERED = {};
    DISCOVERED.initialBalance = INIT_BALANCE;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: SEND_AMOUNT + SEND_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: SEND_AMOUNT + SEND_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.sentBalance;

    genTests({
      name: 'should handle normal receive',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testReceive,
      checker: checkBalances,
      discoverer: defDiscover
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

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
      tx: 1,
      coin: 1,
      confirmed: SEND_AMOUNT,
      unconfirmed: SEND_AMOUNT
    });

    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: -1,
      unconfirmed: -SEND_AMOUNT
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -SEND_AMOUNT
    });

    UNDISCOVERED.unconfirmedBalance = applyDelta(UNDISCOVERED.confirmedBalance, {
      confirmed: SEND_AMOUNT
    });

    UNDISCOVERED.eraseBalance = applyDelta(UNDISCOVERED.unconfirmedBalance, {
      tx: -1,
      coin: 1,
      unconfirmed: SEND_AMOUNT
    });

    UNDISCOVERED.blockConfirmedBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: -1,
      confirmed: -SEND_AMOUNT,
      unconfirmed: -SEND_AMOUNT
    });

    UNDISCOVERED.blockUnconfirmedBalance = applyDelta(UNDISCOVERED.blockConfirmedBalance, {
      confirmed: SEND_AMOUNT
    });

    it('should spend normal credit (no discovery)', async () => {
      const balances = UNDISCOVERED;

      await test(
        checkBalances(balances),
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

    // Balances.
    const UNDISCOVERED = {};

    // For this test, the balances are same for all the test cases,
    // but for different reasons.
    UNDISCOVERED.initialBalance = INIT_BALANCE;

    // We receive 2 transactions (receiving one and spending one)
    // But we spend discovered output right away.
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 2,
      coin: 0,
      unconfirmed: 0
    });

    // Nothing changes for confirmed either. (Coins are spent in pending)
    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {});
    UNDISCOVERED.unconfirmedBalance = applyDelta(UNDISCOVERED.confirmedBalance, {});

    // We no longer have two txs.
    UNDISCOVERED.eraseBalance = applyDelta(UNDISCOVERED.unconfirmedBalance, { tx: -2 });
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    const checks = checkBalances(UNDISCOVERED);

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

      // TODO: Should 0 value outs be counted towards coin and stored in coin set?
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

      // TODO: Should 0 value outs be counted towards coin and stored in coin set?
      balances.eraseBalance = applyDelta(balances.unconfirmedBalance, {
        tx: -1,
        coin: -1,
        unconfirmed: HARD_FEE
      });

      balances.blockConfirmedBalance = balances.confirmedBalance;
      balances.blockUnconfirmedBalance = balances.unconfirmedBalance;

      await testOpen(
        checkBalances(balances),
        defDiscover,
        DISCOVER_TYPES.NONE
      );
    });
  });

  /*
   * Lock balances
   */

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

    // Balances if second BID was undiscovered.
    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      // We have additional coin because: output -> BID + Change
      // Additional BID is undiscovered.
      coin: 1,
      // Bid we are not aware of is seen as spent.
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    // Balances if second BID was discovered right away.
    const DISCOVERED = {};
    DISCOVERED.initialBalance = INIT_BALANCE;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      // Bid we are not aware of is seen as spent.
      unconfirmed: -HARD_FEE,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should receive bid',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testBidReceive,
      checker: checkBalances,
      discoverer: defDiscover
    });
  });

  describe('NONE -> BID* (foreign bid)', function() {
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

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      // only BID
      coin: 1,
      // We did not own this money before
      unconfirmed: BLIND_AMOUNT_1,
      ulocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: BLIND_AMOUNT_1,
      clocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.sentBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = INIT_BALANCE;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.sentBalance;

    genTests({
      name: 'should receive foreign bid',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testForeign,
      checker: checkBalances,
      discoverer: defDiscover
    });
  });

  describe('NONE -> BID* (cross acct)', function() {
    before(() => {
      genWallets = 6;
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

    const UNDISCOVERED_WALLET = {};
    const UNDISCOVERED_DEFAULT = {};
    const UNDISCOVERED_ALT = {};

    UNDISCOVERED_WALLET.initialBalance = INIT_BALANCE;
    UNDISCOVERED_DEFAULT.initialBalance = INIT_BALANCE;
    UNDISCOVERED_ALT.initialBalance = NULL_BALANCE;

    // sent from default to alt, default account does not lock
    UNDISCOVERED_DEFAULT.sentBalance = applyDelta(UNDISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      // output -> change output + 2 BIDs to alt
      coin: 0,
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    // alt account balance locks unconfirmed and receives coin.
    UNDISCOVERED_ALT.sentBalance = applyDelta(UNDISCOVERED_ALT.initialBalance, {
      tx: 1,
      // received BID + missed BID.
      coin: 1,
      unconfirmed: BLIND_AMOUNT_1,
      ulocked: BLIND_AMOUNT_1
    });

    // Wallet only spends FEE
    UNDISCOVERED_WALLET.sentBalance = applyDelta(UNDISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // Total coins is: output -> BID output + CHANGE + Undiscovered BID
      coin: 1,
      // for now another bid just out transaction.
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1
    });

    // NOW CONFIRM
    UNDISCOVERED_DEFAULT.confirmedBalance = applyDelta(UNDISCOVERED_DEFAULT.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_ALT.confirmedBalance = applyDelta(UNDISCOVERED_ALT.sentBalance, {
      confirmed: BLIND_AMOUNT_1,
      clocked: BLIND_AMOUNT_1
    });

    UNDISCOVERED_WALLET.confirmedBalance = applyDelta(UNDISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1
    });

    // NOW Unconfirm again
    UNDISCOVERED_DEFAULT.unconfirmedBalance = UNDISCOVERED_DEFAULT.sentBalance;
    UNDISCOVERED_ALT.unconfirmedBalance = UNDISCOVERED_ALT.sentBalance;
    UNDISCOVERED_WALLET.unconfirmedBalance = UNDISCOVERED_WALLET.sentBalance;

    // NOW Erase
    UNDISCOVERED_WALLET.eraseBalance = UNDISCOVERED_WALLET.initialBalance;
    UNDISCOVERED_DEFAULT.eraseBalance = UNDISCOVERED_DEFAULT.initialBalance;
    UNDISCOVERED_ALT.eraseBalance = UNDISCOVERED_ALT.initialBalance;

    UNDISCOVERED_WALLET.blockConfirmedBalance = UNDISCOVERED_WALLET.confirmedBalance;
    UNDISCOVERED_DEFAULT.blockConfirmedBalance = UNDISCOVERED_DEFAULT.confirmedBalance;
    UNDISCOVERED_ALT.blockConfirmedBalance = UNDISCOVERED_ALT.confirmedBalance;

    UNDISCOVERED_WALLET.blockUnconfirmedBalance = UNDISCOVERED_WALLET.unconfirmedBalance;
    UNDISCOVERED_DEFAULT.blockUnconfirmedBalance = UNDISCOVERED_DEFAULT.unconfirmedBalance;
    UNDISCOVERED_ALT.blockUnconfirmedBalance = UNDISCOVERED_ALT.unconfirmedBalance;

    // Now DISCOVERED PART
    const DISCOVERED_WALLET = {};
    const DISCOVERED_DEFAULT = {};
    const DISCOVERED_ALT = {};

    DISCOVERED_WALLET.initialBalance = INIT_BALANCE;
    DISCOVERED_DEFAULT.initialBalance = INIT_BALANCE;
    DISCOVERED_ALT.initialBalance = NULL_BALANCE;

    // sent from default to alt, default account does not lock
    DISCOVERED_DEFAULT.sentBalance = applyDelta(DISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      coin: 0,
      unconfirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    // alt account balance locks unconfirmed and receives coin.
    DISCOVERED_ALT.sentBalance = applyDelta(DISCOVERED_ALT.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // Wallet only spends FEE
    DISCOVERED_WALLET.sentBalance = applyDelta(DISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // Total coins is: output -> BID output + BID output + CHANGE
      coin: 2,
      unconfirmed: -HARD_FEE,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // NOW CONFIRM
    DISCOVERED_DEFAULT.confirmedBalance = applyDelta(DISCOVERED_DEFAULT.sentBalance, {
      confirmed: -HARD_FEE - BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    DISCOVERED_ALT.confirmedBalance = applyDelta(DISCOVERED_ALT.sentBalance, {
      confirmed: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    DISCOVERED_WALLET.confirmedBalance = applyDelta(DISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // NOW Unconfirm again
    DISCOVERED_DEFAULT.unconfirmedBalance = DISCOVERED_DEFAULT.sentBalance;
    DISCOVERED_ALT.unconfirmedBalance = DISCOVERED_ALT.sentBalance;
    DISCOVERED_WALLET.unconfirmedBalance = DISCOVERED_WALLET.sentBalance;

    // NOW Erase
    DISCOVERED_WALLET.eraseBalance = DISCOVERED_WALLET.initialBalance;
    DISCOVERED_DEFAULT.eraseBalance = DISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_ALT.eraseBalance = DISCOVERED_ALT.initialBalance;

    DISCOVERED_WALLET.blockConfirmedBalance = DISCOVERED_WALLET.confirmedBalance;
    DISCOVERED_DEFAULT.blockConfirmedBalance = DISCOVERED_DEFAULT.confirmedBalance;
    DISCOVERED_ALT.blockConfirmedBalance = DISCOVERED_ALT.confirmedBalance;

    DISCOVERED_WALLET.blockUnconfirmedBalance = DISCOVERED_WALLET.unconfirmedBalance;
    DISCOVERED_DEFAULT.blockUnconfirmedBalance = DISCOVERED_DEFAULT.unconfirmedBalance;
    DISCOVERED_ALT.blockUnconfirmedBalance = DISCOVERED_ALT.unconfirmedBalance;

    genTests({
      name: 'should send/receive bid cross acct',
      undiscovered: [UNDISCOVERED_WALLET, UNDISCOVERED_DEFAULT, UNDISCOVERED_ALT],
      discovered: [DISCOVERED_WALLET, DISCOVERED_DEFAULT, DISCOVERED_ALT],
      tester: testCrossAcctBalance,
      checker: checkBalances,
      discoverer: altDiscover
    });
  });

  describe('BID* -> REVEAL*', function() {
    before(() => {
      genWallets = 6;
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

    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
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
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      // extra coin from Change
      coin: 1,
      // We recover BLIND_ONLY from the unknown BID via change.
      unconfirmed: BLIND_ONLY_2 - HARD_FEE,
      ulocked: -BLIND_ONLY_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: BLIND_ONLY_2 - HARD_FEE,
      clocked: -BLIND_ONLY_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    const DISCOVERED = {};
    DISCOVERED.initialBalance = applyDelta(INIT_BALANCE, {
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
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,
      unconfirmed: BLIND_AMOUNT_2 - HARD_FEE,
      ulocked: BID_AMOUNT_2 - BLIND_ONLY_1
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: BLIND_AMOUNT_2 - HARD_FEE,
      clocked: BID_AMOUNT_2 - BLIND_ONLY_1
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.unconfirmedBalance;

    genTests({
      name: 'should send/receive reveal',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testReveal,
      checker: checkBalances,
      discoverer: defDiscover
    });
  });

  describe('BID* -> REVEAL* (cross acct)', function() {
    before(() => {
      genWallets = 6;
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

    /*
     * Balances if we never discovered missing.
     */

    const UNDISCOVERED_WALLET = {};
    const UNDISCOVERED_DEFAULT = {};
    const UNDISCOVERED_ALT = {};

    // we start with BID transaction
    UNDISCOVERED_WALLET.initialBalance = applyDelta(INIT_BALANCE, {
      tx: 1,

      // we have two bids at the start.
      coin: 2,

      confirmed: -HARD_FEE,
      unconfirmed: -HARD_FEE,

      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // same as wallet at this stage.
    UNDISCOVERED_DEFAULT.initialBalance = UNDISCOVERED_WALLET.initialBalance;
    // empty at the start.
    UNDISCOVERED_ALT.initialBalance = NULL_BALANCE;

    // After REVEAL Transaction
    UNDISCOVERED_WALLET.sentBalance = applyDelta(UNDISCOVERED_WALLET.initialBalance, {
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
    UNDISCOVERED_DEFAULT.sentBalance = applyDelta(UNDISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      // 2 BIDS -> 1 Change + out 2 reveals
      coin: -1,

      unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_ALT.sentBalance = applyDelta(UNDISCOVERED_ALT.initialBalance, {
      tx: 1,
      // we received 1 reveal (another is unknown)
      coin: 1,

      unconfirmed: BID_AMOUNT_1,
      ulocked: BID_AMOUNT_1
    });

    // Now we confirm everything seen above.
    UNDISCOVERED_WALLET.confirmedBalance = applyDelta(UNDISCOVERED_WALLET.sentBalance, {
      confirmed: -BID_AMOUNT_2 - HARD_FEE,
      clocked: -BLIND_ONLY_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_DEFAULT.confirmedBalance = applyDelta(UNDISCOVERED_DEFAULT.sentBalance, {
      confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    UNDISCOVERED_ALT.confirmedBalance = applyDelta(UNDISCOVERED_ALT.sentBalance, {
      confirmed: BID_AMOUNT_1,
      clocked: BID_AMOUNT_1
    });

    UNDISCOVERED_WALLET.unconfirmedBalance = UNDISCOVERED_WALLET.sentBalance;
    UNDISCOVERED_DEFAULT.unconfirmedBalance = UNDISCOVERED_DEFAULT.sentBalance;
    UNDISCOVERED_ALT.unconfirmedBalance = UNDISCOVERED_ALT.sentBalance;

    // Erase
    UNDISCOVERED_WALLET.eraseBalance = UNDISCOVERED_WALLET.initialBalance;
    UNDISCOVERED_DEFAULT.eraseBalance = UNDISCOVERED_DEFAULT.initialBalance;
    UNDISCOVERED_ALT.eraseBalance = UNDISCOVERED_ALT.initialBalance;

    // Confirm in block
    UNDISCOVERED_WALLET.blockConfirmedBalance = UNDISCOVERED_WALLET.confirmedBalance;
    UNDISCOVERED_DEFAULT.blockConfirmedBalance = UNDISCOVERED_DEFAULT.confirmedBalance;
    UNDISCOVERED_ALT.blockConfirmedBalance = UNDISCOVERED_ALT.confirmedBalance;

    // Unconfirm in block
    UNDISCOVERED_WALLET.blockUnconfirmedBalance = UNDISCOVERED_WALLET.unconfirmedBalance;
    UNDISCOVERED_DEFAULT.blockUnconfirmedBalance = UNDISCOVERED_DEFAULT.unconfirmedBalance;
    UNDISCOVERED_ALT.blockUnconfirmedBalance = UNDISCOVERED_ALT.unconfirmedBalance;

    /*
     * Balances if we had discovered it right away.
     */

    const DISCOVERED_WALLET = {};
    const DISCOVERED_DEFAULT = {};
    const DISCOVERED_ALT = {};

    DISCOVERED_WALLET.initialBalance = applyDelta(INIT_BALANCE, {
      tx: 1,
      coin: 2,

      confirmed: -HARD_FEE,
      unconfirmed: -HARD_FEE,

      clocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2,
      ulocked: BLIND_AMOUNT_1 + BLIND_AMOUNT_2
    });

    // same as wallet at this stage.
    DISCOVERED_DEFAULT.initialBalance = DISCOVERED_WALLET.initialBalance;
    // empty at the start.
    DISCOVERED_ALT.initialBalance = NULL_BALANCE;

    // After REVEAL Transaction
    DISCOVERED_WALLET.sentBalance = applyDelta(DISCOVERED_WALLET.initialBalance, {
      tx: 1,
      // extra change introduce by reveal tx.
      coin: 1,

      unconfirmed: -HARD_FEE,
      // unlock blinds, only BID are left locked.
      ulocked: -BLIND_ONLY_1 - BLIND_ONLY_2
    });

    // does not change
    DISCOVERED_DEFAULT.sentBalance = applyDelta(DISCOVERED_DEFAULT.initialBalance, {
      tx: 1,
      // 2 BIDS -> 1 Change + out 2 reveals
      coin: -1,

      unconfirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      ulocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    DISCOVERED_ALT.sentBalance = applyDelta(DISCOVERED_ALT.initialBalance, {
      tx: 1,
      // we received 2 reveal
      coin: 2,

      unconfirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      ulocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    // Now we confirm everything seen above.
    DISCOVERED_WALLET.confirmedBalance = applyDelta(DISCOVERED_WALLET.sentBalance, {
      confirmed: -HARD_FEE,
      clocked: -BLIND_ONLY_1 - BLIND_ONLY_2
    });

    DISCOVERED_DEFAULT.confirmedBalance = applyDelta(DISCOVERED_DEFAULT.sentBalance, {
      confirmed: -BID_AMOUNT_1 - BID_AMOUNT_2 - HARD_FEE,
      clocked: -BLIND_AMOUNT_1 - BLIND_AMOUNT_2
    });

    DISCOVERED_ALT.confirmedBalance = applyDelta(DISCOVERED_ALT.sentBalance, {
      confirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      clocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    DISCOVERED_WALLET.unconfirmedBalance = DISCOVERED_WALLET.sentBalance;
    DISCOVERED_DEFAULT.unconfirmedBalance = DISCOVERED_DEFAULT.sentBalance;
    DISCOVERED_ALT.unconfirmedBalance = DISCOVERED_ALT.sentBalance;

    // Erase
    DISCOVERED_WALLET.eraseBalance = DISCOVERED_WALLET.initialBalance;
    DISCOVERED_DEFAULT.eraseBalance = DISCOVERED_DEFAULT.initialBalance;
    DISCOVERED_ALT.eraseBalance = DISCOVERED_ALT.initialBalance;

    // Confirm in block
    DISCOVERED_WALLET.blockConfirmedBalance = DISCOVERED_WALLET.confirmedBalance;
    DISCOVERED_DEFAULT.blockConfirmedBalance = DISCOVERED_DEFAULT.confirmedBalance;
    DISCOVERED_ALT.blockConfirmedBalance = DISCOVERED_ALT.confirmedBalance;

    // Unconfirm in block
    DISCOVERED_WALLET.blockUnconfirmedBalance = DISCOVERED_WALLET.unconfirmedBalance;
    DISCOVERED_DEFAULT.blockUnconfirmedBalance = DISCOVERED_DEFAULT.unconfirmedBalance;
    DISCOVERED_ALT.blockUnconfirmedBalance = DISCOVERED_ALT.unconfirmedBalance;

    genTests({
      name: 'should send/receive reveal',
      undiscovered: [UNDISCOVERED_WALLET, UNDISCOVERED_DEFAULT, UNDISCOVERED_ALT],
      discovered: [DISCOVERED_WALLET, DISCOVERED_DEFAULT, DISCOVERED_ALT],
      tester: testCrossActReveal,
      checker: checkBalances,
      discoverer: altDiscover
    });
  });

  describe('BID -> REVEAL* (foreign reveal)', function() {
    before(() => {
      genWallets = 6;
      return beforeAll();
    });

    after(afterAll);

    let name;
    const setupRevealName = async () => {
      name = grindName(GRIND_NAME_LEN, chain.tip.height, network);

      await primary.sendOpen(name, false);
      await mineBlocks(openingPeriod);
      await primary.sendBatch([
        ['BID', name, BID_AMOUNT_1, BLIND_AMOUNT_1],
        ['BID', name, BID_AMOUNT_2, BLIND_AMOUNT_2]
      ]);
      await mineBlocks(biddingPeriod);
    };

    const sendReveal = async (wallet, account, ahead) => {
      const {nextAddr} = getAheadAddr(account, ahead);
      const recv = await wallet.receiveAddress();

      const mtx = await primary.createReveal(name);
      assert.strictEqual(mtx.outputs[0].covenant.type, types.REVEAL);
      assert.strictEqual(mtx.outputs[1].covenant.type, types.REVEAL);

      mtx.outputs[0].address = recv;
      mtx.outputs[1].address = nextAddr;
      await resign(primary, mtx);

      node.mempool.addTX(mtx.toTX());
      await forWTX(wallet.id, mtx.hash());
    };

    const AHEAD = 10;
    const testForeignReveal = balanceTest(setupRevealName, sendReveal, AHEAD);

    // balances if missing reveal was not discovered.
    const UNDISCOVERED = {};
    UNDISCOVERED.initialBalance = INIT_BALANCE;
    UNDISCOVERED.sentBalance = applyDelta(UNDISCOVERED.initialBalance, {
      tx: 1,
      coin: 1,

      unconfirmed: BID_AMOUNT_1,
      ulocked: BID_AMOUNT_1
    });

    UNDISCOVERED.confirmedBalance = applyDelta(UNDISCOVERED.sentBalance, {
      confirmed: BID_AMOUNT_1,
      clocked: BID_AMOUNT_1
    });

    UNDISCOVERED.unconfirmedBalance = UNDISCOVERED.sentBalance;
    UNDISCOVERED.eraseBalance = UNDISCOVERED.initialBalance;
    UNDISCOVERED.blockConfirmedBalance = UNDISCOVERED.confirmedBalance;
    UNDISCOVERED.blockUnconfirmedBalance = UNDISCOVERED.unconfirmedBalance;

    // Balances if everyting was discovered from the begining.
    const DISCOVERED = {};
    DISCOVERED.initialBalance = INIT_BALANCE;
    DISCOVERED.sentBalance = applyDelta(DISCOVERED.initialBalance, {
      tx: 1,
      coin: 2,

      unconfirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      ulocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    DISCOVERED.confirmedBalance = applyDelta(DISCOVERED.sentBalance, {
      confirmed: BID_AMOUNT_1 + BID_AMOUNT_2,
      clocked: BID_AMOUNT_1 + BID_AMOUNT_2
    });

    DISCOVERED.unconfirmedBalance = DISCOVERED.sentBalance;
    DISCOVERED.eraseBalance = DISCOVERED.initialBalance;
    DISCOVERED.blockConfirmedBalance = DISCOVERED.confirmedBalance;
    DISCOVERED.blockUnconfirmedBalance = DISCOVERED.sentBalance;

    genTests({
      name: 'should send/receive reveal',
      undiscovered: UNDISCOVERED,
      discovered: DISCOVERED,
      tester: testForeignReveal,
      checker: checkBalances,
      discoverer: defDiscover
    });
  });
});
