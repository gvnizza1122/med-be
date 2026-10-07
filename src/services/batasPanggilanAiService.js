// Batas bersama untuk semua tahap; antrean tidak ikut timeout permintaan penyedia.
let active=0;
const pending=[];
function batas() { return Math.max(1,Math.min(20,Number(process.env.AI_CALL_CONCURRENCY)||6)); }
function drain() {
  while(active<batas() && pending.length) {
    const {fn,resolve,reject}=pending.shift();active++;
    Promise.resolve().then(fn).then(resolve,reject).finally(()=>{active--;drain();});
  }
}
function jalankan(fn) { return new Promise((resolve,reject)=>{pending.push({fn,resolve,reject});drain();}); }
module.exports={jalankan};
