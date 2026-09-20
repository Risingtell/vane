// Deployment the console points at. Updated from the demo-run summary.
window.VANE_AGENT    = "0xb1341FE72F6f0d77168faD310336847686f8A852";
window.VANE_FACTORY  = "0x7b0e95BeE84eba85f0AB975a6785F84CA6F3D41F";
window.VANE_OPERATOR = "0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053";

// Fixed points on the chain the console measures against. Every one of them is a block
// number anyone can read state at, so nothing here is a claim the page asks you to trust.
window.VANE_DEPLOY_BLOCK = 482370702;              // agent bytecode first present, 7 Sep 2026 19:44 UTC
window.VANE_CLOSE = {                               // hackathon judging closed
  time: "2026-09-11T18:00:00Z",
  label: "11 Sep 2026, 19:00 Kano",
};
window.VANE_ARM = {                                 // the standing instructions in force right now
  block: 485835840,
  time: "2026-09-11T20:00:52Z",
  subs: ["0x118fadc", "0x118faea"],
  txs: [
    "0x5e3671340f067a6c14abb3661ab9ff650bc4f837f817fdd49130e49e53510596",
    "0xd2f4f0d51beb83ef0b8dc33c4ca40537652e9777e807dd6bb6c93fc69b97eefb",
  ],
};
