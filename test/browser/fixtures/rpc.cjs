const assert = require('node:assert/strict');
const { RPCSerializer, RPCJsonSerializer } = require('@orpc/client');
const { ownerOutputs } = require('@multiagency/sdk');

const serializer = new RPCSerializer(new RPCJsonSerializer());

/** What the app shows for any failed read: ownerClient classifies it as `unavailable`, without the server's words. */
const UNAVAILABLE = 'This read failed or returned an answer that could not be verified. Reading again is safe.';

/** Every RPC, including a write, must be deliberately declared by the scenario. */
function rpcValue(values, method) {
  assert.ok(Object.hasOwn(values, method), `Unexpected RPC: ${method}`);
  // Explicit undefined is a legitimate void RPC result; absent properties are never accepted.
  return values[method];
}

/**
 * An answer (or one stream event) as the real agent server sends it: checked against the published
 * owner contract, then encoded by oRPC's own serializer, so bigints and absent values match the wire.
 */
function rpcAnswer(method, value) {
  const schema = ownerOutputs[method];
  assert.ok(schema, `No published owner output for ${method}`);
  const parsed = schema.safeParse(value);
  assert.ok(parsed.success, `Fixture for ${method} does not match the published output: ${parsed.error?.issues
    .slice(0, 8).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return serializer.serialize(value);
}

/**
 * An answer the published contract cannot produce, encoded like a real one. It must fail the
 * published schema, so a scenario about client-side rejection can never silently become valid.
 */
function rpcMalformed(method, value) {
  const schema = ownerOutputs[method];
  assert.ok(schema, `No published owner output for ${method}`);
  assert.ok(!schema.safeParse(value).success, `Malformed fixture for ${method} unexpectedly matches the published output`);
  return serializer.serialize(value);
}

/** A declared scenario value, answered as the server would. */
const rpcBody = (values, method) => rpcAnswer(method, rpcValue(values, method));

/** Server-sent events for a streamed procedure, each event checked and encoded like a real answer. */
// Ends with `event: close`, as oRPC's server does: SDK 0.4.0's client reads a stream that stops without it as lost (unknown).
const rpcEvents = (method, events) => events.map(event => `data: ${JSON.stringify(rpcAnswer(method, event))}\n\n`).join('') + 'event: close\n\n';

module.exports = { rpcValue, rpcAnswer, rpcBody, rpcEvents, rpcMalformed, UNAVAILABLE };
