import test from 'node:test';
import assert from 'node:assert/strict';
import {recallWithDeadline} from '../recall-deadline.js';

test('semantic recall returns immediately on success and cleans up its signal',async()=>{
  let provided;
  const rows=await recallWithDeadline(signal=>{
    provided=signal;
    assert.equal(signal.aborted,false);
    return [{key:'floor:8'}];
  },200);
  assert.deepEqual(rows,[{key:'floor:8'}]);
  assert.equal(provided.aborted,true);
});

test('semantic recall uses a real deadline even when a provider ignores abort',async()=>{
  let provided;
  const started=performance.now();
  const rows=await recallWithDeadline(signal=>{
    provided=signal;
    return new Promise(()=>{}); // Uncooperative API never settles.
  },20);
  assert.deepEqual(rows,[]);
  assert.equal(provided.aborted,true);
  assert.ok(performance.now()-started<1000,'timeout must not await stalled promise');
});

test('semantic recall failures, invalid results and late rejection fail open',async()=>{
  assert.deepEqual(await recallWithDeadline(()=>Promise.reject(Error('offline')),200),[]);
  assert.deepEqual(await recallWithDeadline(()=>undefined,200),[]);
  let rejectLate;
  const wait=new Promise((_,reject)=>{rejectLate=reject;});
  assert.deepEqual(await recallWithDeadline(()=>wait,5),[]);
  rejectLate(Error('late response'));
  await new Promise(resolve=>setImmediate(resolve));
});

test('fast semantic results do not lose the local search fallback',async()=>{
  const rows=await recallWithDeadline(async()=>[{key:'entity:characters:1',score:.8}],50);
  assert.equal(rows[0].key,'entity:characters:1');
});
