// Optional Edgegap matchmaker. Leave both empty and the game works as Manus built it: room code +
// ?server=ws://host:port/ws. Fill them in (Edgegap dashboard > Matchmaker > your matchmaker >
// API URL and Auth Token), or pass ?mm=<url>&token=<token> in the page URL, and the lobby shows
// FIND MATCH: the matchmaker starts one Edgegap server per match, near the players.
//
// The Auth Token is the matchmaker's client token: it is made to ship in game clients and gives no
// access to your Edgegap account. Never put your Edgegap API token here.
export default {
  matchmakerUrl: "",
  matchmakerToken: "",
  matchmakerProfile: "arena", // profile name in your matchmaker config (also ?profile=)
};
