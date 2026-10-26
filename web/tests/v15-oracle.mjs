import {readFileSync} from 'node:fs';
import {startRun,advanceRun} from '../public/execution-engine.mjs';
const config=JSON.parse(readFileSync(0,'utf8')), map=new Map();
const storage={getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};
let state=startRun(storage,config,'parity-run-001');const trajectory=[];
for(let i=0;i<100&&!state.view.complete;i++){
 state=advanceRun(storage);trajectory.push({account:state.view.account,time:state.view.time,stage:state.view.orders.at(-1)?.status??null,interrupted:!!state.interrupted});
}
process.stdout.write(JSON.stringify({trajectory,view:state.view}));
