#!/usr/bin/env node
// vane: drive an on-chain trading agent from the command line.
//
// Every command talks to Somnia and to the agent contract directly. There is no service in
// the middle, which is the whole point of the project.

import { Wallet } from "ethers";
import {
  SHANNON, provider, status, subscriptions, subscriptionInfo, arm, disarm,
  reclaim, sweep, liveMarkets, createAgent, fund, faucet, MIN_OWNER_STT, close,
} from "./index.js";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name, fallback) {
  const i = args.indexOf("--" + name);
  return i === -1 ? fallback : args[i + 1];
}

function signer() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error("Set PRIVATE_KEY to a Shannon testnet key. Never use a key that holds real funds.");
    process.exit(1);
  }
  return new Wallet(pk, provider(flag("rpc", SHANNON.rpc)));
}

function need(value, name) {
  if (!value) {
    console.error(`--${name} is required`);
    process.exit(1);
  }
  return value;
}

const HELP = `
vane: an on-chain trading agent for DreamDEX event contracts

  vane markets                          windows open right now
  vane status   --agent 0x..            everything the agent has done
  vane subs     --owner 0x..            what the node is holding for an account

  vane faucet                           claim 10,000 test tUSDC
  vane create   --factory 0x..          deploy your own agent
  vane fund     --agent 0x.. --amount N move collateral into it

  vane arm      --agent 0x.. --topic 0x..   hand it to the chain
  vane disarm                               take it back, and stop spending STT

  vane reclaim  --agent 0x.. --pool 0x..                    free escrow from expired orders
  vane sweep    --agent 0x.. --market-id 0x.. --market 0x.. claim a settled position

Writes need PRIVATE_KEY in the environment. Reads need nothing.

Two numbers worth knowing before you arm anything:
  - the subscription owner must hold at least ${MIN_OWNER_STT} STT, and the chain
    rejects below that with no revert reason at all
  - a wake needs roughly 4M gas to place an order, so the subscription is armed with 8M
`;

async function main() {
  switch (cmd) {
    case "markets": {
      const now = Math.floor(Date.now() / 1000);
      for (const m of await liveMarkets({ limit: Number(flag("limit", 5)) })) {
        console.log(
          String(Number(m.expiry) - now).padStart(6) + "s",
          "| " + m.question.slice(0, 44).padEnd(44),
          "| pool " + m.poolAddress,
        );
      }
      break;
    }
    case "status": {
      const s = await status(need(flag("agent"), "agent"));
      for (const [k, v] of Object.entries(s)) console.log(k.padEnd(16), v);
      break;
    }
    case "subs": {
      const owner = need(flag("owner"), "owner");
      const ids = await subscriptions(owner);
      if (!ids.length) { console.log("no subscriptions; the chain is not waking anything for this account"); break; }
      for (const id of ids) {
        const info = await subscriptionInfo(id);
        console.log("#" + id, "handler", info?.handler_contract_address, "gas", info?.gas_limit);
      }
      break;
    }
    case "faucet": {
      const rc = await faucet(signer(), flag("amount", "10000"));
      console.log("claimed, tx", rc.hash);
      break;
    }
    case "create": {
      const addr = await createAgent(signer(), need(flag("factory"), "factory"));
      console.log("agent", addr);
      console.log(SHANNON.explorer + "/address/" + addr);
      break;
    }
    case "fund": {
      const rc = await fund(signer(), need(flag("agent"), "agent"), need(flag("amount"), "amount"));
      console.log("funded, tx", rc.hash);
      break;
    }
    case "arm": {
      const ids = await arm(signer(), need(flag("agent"), "agent"), {
        topic0: need(flag("topic"), "topic"),
        gasLimit: BigInt(flag("gas", "8000000")),
      });
      console.log("armed. the chain now holds:", ids.join(", "));
      break;
    }
    case "disarm": {
      const ids = await disarm(signer());
      console.log(ids.length ? "cancelled " + ids.join(", ") : "nothing was armed");
      break;
    }
    case "reclaim": {
      const rc = await reclaim(signer(), need(flag("agent"), "agent"), need(flag("pool"), "pool"));
      console.log("tx", rc.hash);
      break;
    }
    case "sweep": {
      const rc = await sweep(
        signer(), need(flag("agent"), "agent"),
        need(flag("market-id"), "market-id"), need(flag("market"), "market"),
      );
      console.log("tx", rc.hash);
      break;
    }
    default:
      console.log(HELP);
  }
}

/**
 * End cleanly. Closing the RPC connection usually lets Node exit on its own, which keeps the
 * output free of the libuv assertion that forcing exit can trigger. The unref'd timer is a
 * backstop: it only fires if something else is still holding the loop open, so a command can
 * never hang, which an automated reviewer would read as a failure.
 */
function finish(code) {
  close();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 400).unref();
}

main().then(
  () => finish(0),
  (e) => { console.error(e.shortMessage || e.message || e); finish(1); },
);
