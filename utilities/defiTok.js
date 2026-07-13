/**
 * Token Decimals Configuration
 * Auto-generated from tokenDecimals.json
 * Last updated: 2025-11-14T02:22:28.768Z
 * 
 * Total tokens: 202
 */
const spl_token_1 = require("@solana/spl-token");
const { decimal } = require("decimal.js");

const TOKEN_DECIMALS = {
    "So11111111111111111111111111111111111111112": {
        "decimals": 9,
        "symbol": "SOL"
    },
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
        "decimals": 6,
        "symbol": "USDC"
    },
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
        "decimals": 6,
        "symbol": "USDT"
    },
    "1Qf8gESP4i6CFNWerUSDdLKJ9U1LpqTYvjJ2MM4pain": {
        "decimals": 6,
        "symbol": "PAIN"
    },
    "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": {
        "decimals": 5,
        "symbol": "BONK"
    },
    "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": {
        "decimals": 6,
        "symbol": "TRUMP"
    },
    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": {
        "decimals": 6,
        "symbol": "RAY"
    },
    "NomuBwKJEvJ8d4dsaq7NZoHaXWXzKcfke1c7Y8ruFYL": {
        "decimals": 9,
        "symbol": "NOMU"
    },
    "NUZ3FDWTtN5SP72BsefbsqpnbAY5oe21LE8bCSkqsEK": {
        "decimals": 6,
        "symbol": "FLP.1"
    },
    "METADDFL6wWMWEoKTFJwcThTbUmtarRJZjRpzUvkxhr": {
        "decimals": 9,
        "symbol": "META"
    },
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": {
        "decimals": 9,
        "symbol": "mSOL"
    },
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn": {
        "decimals": 9,
        "symbol": "jitoSOL"
    },
    "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": {
        "decimals": 9,
        "symbol": "stSOL"
    },
    "ZA4vqAcejc8TwDbgqd4gMmr1FpubUwzSGmhLYhgLaHE": {
        "decimals": 6,
        "symbol": null
    },

    "ApJEJEnXSwCoWKynr54whxDgcQWdQ8iGJ2tkDpnmpump": {
        "decimals": 6,
        "symbol": null
    },
    "E1XGEP1nk3BLxpnkWfqVnpVTA13RYzpY6Na1XD2Kpump": {
        "decimals": 6,
        "symbol": "QUASAR"
    },
    "62ZiwfjUj8rihfYyBUTL4P1ftzCkvLqT7ivqtSBwpump": {
        "decimals": 6,
        "symbol": null
    },
    "C2RLcU3jB7mjzGSi9wb7emTWmRcXagSyMH68jLiVpump": {
        "decimals": 6,
        "symbol": null
    },
    "FNrwxRPRTtrRtFjogkJXxgY6mB5S71kgiEvjj4UgwV3K": {
        "decimals": 6,
        "symbol": null
    },
    "Eeuqq5Jgp6BfbkQZUXJBhWgozpYuP9Ej71FAsfZ3tRRM": {
        "decimals": 6,
        "symbol": null
    },
    "GMvCfcZg8YvkkQmwDaAzCtHDrrEtgE74nQpQ7xNabonk": {
        "decimals": 6,
        "symbol": "1"
    },
    "Ax8PSfCXxmxb8C8kYTzN5CPpTe6PyeZfFf8rrXNCjupx": {
        "decimals": 6,
        "symbol": "MM"
    },
    "CboMcTUYUcy9E6B3yGdFn6aEsGUnYV6yWeoeukw6pump": {
        "decimals": 6,
        "symbol": "Butthole"
    },
    "A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump": {
        "decimals": 6,
        "symbol": "FWOG"
    },
    "5evN2exivZXJfLaA1KhHfiJKWfwH8znqyH36w1SFz89Y": {
        "decimals": 6,
        "symbol": "MIRAI"
    },
    "sCLN9rN7hZGWgLm4xurniAb7L1SLS1if4HHh37ypump": {
        "decimals": 6,
        "symbol": null
    },
    "H7ASztrWPx5E7NgVZxELRAwiNGkUmwsZtWutXpYFpump": {
        "decimals": 6,
        "symbol": null
    },
    "HZAc3jo6TEJhx2meJBbcmL32o2iKehuu5ZA4bSnUbonk": {
        "decimals": 6,
        "symbol": null
    },
    "ExocdWVMKbZBsMo21M6c6SCj7n4k4s7vmUVz3mGvpump": {
        "decimals": 6,
        "symbol": "∅"
    },
    "4pyktCdWhXgWRsMe7zPboVJaA75g5XrwTU73My1Upump": {
        "decimals": 6,
        "symbol": null
    },
    "DWEsJwPRrFscjH8krbMryHo6UNQ3tAd7kK3SPVcYTiHH": {
        "decimals": 8,
        "symbol": null
    },
    "6fuzUuqHtCs33ZStcsVGqEpWAkRrywmCjG6Vy1CNpump": {
        "decimals": 6,
        "symbol": null
    },
    "B89Hd5Juz7JP2dxCZXFJWk4tMTcbw7feDhuWGb3kq5qE": {
        "decimals": 9,
        "symbol": "NC"
    },
    "EfF6MSk2L5gFM6THaND7L9vM65bgjKP7sFYCY933pump": {
        "decimals": 6,
        "symbol": null
    },
    "GAkYTCw6Kt2dsyifBbGycrT8YoMCVRR23UrsNDqGBAGS": {
        "decimals": 9,
        "symbol": null
    },
    "ARGkjEeWbMaJetqZbfrw7mLnDwouZCcxSE27EwEQbonk": {
        "decimals": 6,
        "symbol": null
    },
    "3iQL8BFS2vE7mww4ehAqQHAsbmRNCrPxizWAT2Zfyr9y": {
        "decimals": 9,
        "symbol": "VIRTUAL"
    },
    "7eLz7uTp7NX9PuRvEzV3atQTy3H57Bre78kTcufhvirt": {
        "decimals": 6,
        "symbol": null
    },
    "BSqHQohsYwhZRD9djeUvfDT9GuwDAqbrRZvjSyiVpump": {
        "decimals": 6,
        "symbol": null
    },
    "2HAa2vQ5p6intfVcVPajKfG9faDsf6DX6h8am4KK7MgD": {
        "decimals": 9,
        "symbol": null
    },
    "2RBko3xoz56aH69isQMUpzZd9NYHahhwC23A5F3Spkin": {
        "decimals": 6,
        "symbol": "PKIN"
    },
    "6bq8kCaBGPiqjpwV2dACjT4S7aaynA5ZoQ61U3t4pump": {
        "decimals": 6,
        "symbol": "GTA"
    },
    "FtUEW73K6vEYHfbkfpdBZfWpxgQar2HipGdbutEhpump": {
        "decimals": 6,
        "symbol": "titcoin"
    },
    "GoLDDDNBPD72mSCYbC75GoFZ1e97Uczakp8yNi7JHrK4": {
        "decimals": 9,
        "symbol": "GOLD"
    },
    "Fudr9tLFYnd2HNqygB2wi1n69cnE5wKaxXHqyz98bonk": {
        "decimals": 6,
        "symbol": null
    },
    "Ai4CL1SAxVRigxQFwBH8S2JkuL7EqrdiGwTC7JpCpump": {
        "decimals": 6,
        "symbol": "AWR"
    },
    "4uCRv65cB7gqt4uErxjYKmjbV3QLoGqHqTqJ7Ngkpump": {
        "decimals": 6,
        "symbol": "WHAT"
    },
    "DUuqTfp6CxceXiuaqeHoSwH2NoYegPBav8NmcE1azHQU": {
        "decimals": 6,
        "symbol": null
    },
    "Av6qVigkb7USQyPXJkUvAEm4f599WTRvd75PUWBA9eNm": {
        "decimals": 9,
        "symbol": "COST"
    },
    "DEf93bSt8dx58gDFCcz4CwbjYZzjwaRBYAciJYLfdCA9": {
        "decimals": 6,
        "symbol": "KWEEN"
    },
    "7b36cKRYFZsMp3vLByVwfVQxW2ndcYth5rhPnyypump": {
        "decimals": 6,
        "symbol": "PINO"
    },
    "A18GrBLPSWUGg1pp3tg9oJU2KBQrkkKiyykL21b4u22i": {
        "decimals": 8,
        "symbol": "ORBIO"
    },
    "4QQZnjXnmzNT8YgMrUPDjGTdLtLbdpvq4o5Bu2NGTgFe": {
        "decimals": 9,
        "symbol": null
    },
    "33zBJtwaRdfW9asbsF3JE1hiY4MaxbHtPSZn2jCYEEZY": {
        "decimals": 6,
        "symbol": null
    },
    "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL": {
        "decimals": 6,
        "symbol": "MET"
    },
    "CnGb7hJsGdsFyQP2uXNWrUgT5K1tovBA3mNnUZcTpump": {
        "decimals": 6,
        "symbol": "flork"
    },
    "Gb9jGTUrGLvqHacsKDXbxsbEr6pqZb71J661WkBFpump": {
        "decimals": 6,
        "symbol": "JUJU"
    },
    "9m9xsyqRChGRor95fXLGEG9J7xxEnHTZgXkPKC3pump": {
        "decimals": 6,
        "symbol": null
    },
    "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump": {
        "decimals": 6,
        "symbol": "FARTCOIN"
    },
    "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij": {
        "decimals": 8,
        "symbol": "cBTC"
    },
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": {
        "decimals": 8,
        "symbol": "WBTC"
    },
    "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": {
        "decimals": 6,
        "symbol": "JLP"
    },
    "BLVxek8YMXUQhcKmMvrFTrzh5FXg8ec88Crp6otEaCMf": {
        "decimals": 9,
        "symbol": "BELIEVE"
    },

    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": {
        "decimals": 6,
        "symbol": "RAY"
    },
    "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU": {
        "decimals": 6,
        "symbol": "ZBCN"
    },
    "pepo1CFNU2RXf7yXX7HNXazXwxsq8WrPvDHpHriwoLY": {
        "decimals": 6,
        "symbol": "PEPO"
    },
    "yso11zxLbHA3wBJ9HAtVu6wnesqz9A2qxnhxanasZ4N": {
        "decimals": 9,
        "symbol": null
    },
    "LYLikzBQtpa9ZgVrJsqYGQpR3cC1WMJrBHaXGrQmeta": {
        "decimals": 6,
        "symbol": "LOYAL"
    },
    "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump": {
        "decimals": 6,
        "symbol": "neet"
    },
    "CvB1ztJvpYQPvdPBePtRzjL4aQidjydtUz61NWgcgQtP": {
        "decimals": 6,
        "symbol": "EPCT"
    },
    "WLFinEv6ypjkczcS83FZqFpgFZYwQXutRbxGe7oC16g": {
        "decimals": 6,
        "symbol": "WLFI"
    },
    "G4uJcvo5UAJ3fU1gj96e5DjBJU2RDDPx9Txzbjw6Y3LA": {
        "decimals": 9,
        "symbol": "CAESAR"
    },
    "XLnpFRQ3rSWupCRjuQfx74mgVoT3ezVJKE1CogRZxhH": {
        "decimals": 6,
        "symbol": "XLAB"
    },
    "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk": {
        "decimals": 6,
        "symbol": "USELESS"
    },
    "HZqjjeso24PDVdLsVJQyVb8kDnbo7HhXfY1Jane66o9C": {
        "decimals": 9,
        "symbol": "CDR"
    },
    "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv": {
        "decimals": 6,
        "symbol": "PENGU"
    },
    "METAwkXcqyXKy1AtsSgJ8JiUHwGCafnZL38n3vYmeta": {
        "decimals": 6,
        "symbol": "META"
    },
    "LFNTYraetVioAPnGJht4yNg2aUZFXR776cMeN9VMjXp": {
        "decimals": 6,
        "symbol": "LFNTY"
    },
    "xLfNTYy76B8Tiix3hA51Jyvc1kMSFV4sPdR7szTZsRu": {
        "decimals": 6,
        "symbol": "xLFNTY"
    },
    "9AsPPTiQ12Rg2H5vQ4y5qnLSRmCzaoosXkLPiU94Yp7B": {
        "decimals": 8,
        "symbol": null
    },
    "BANKJmvhT8tiJRsBSS1n2HryMBPvT5Ze4HU95DUAmeta": {
        "decimals": 6,
        "symbol": "AVICI"
    },
    "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS": {
        "decimals": 8,
        "symbol": "ZEC"
    },
    "GiG7Hr61RVm4CSUxJmgiCoySFQtdiwxtqf64MsRppump": {
        "decimals": 6,
        "symbol": "SCF"
    },
    "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp": {
        "decimals": 11,
        "symbol": "ORE"
    },
    "3wPQhXYqy861Nhoc4bahtpf7G3e89XCLfZ67ptEfZUSA": {
        "decimals": 6,
        "symbol": "VALOR"
    },
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB": {
        "decimals": 6,
        "symbol": "USD1"
    },
    "DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY": {
        "decimals": 6,
        "symbol": "YZY"
    },
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": {
        "decimals": 6,
        "symbol": "JUP"
    },
    "9McvH6w97oewLmPxqQEoHUAv3u5iYMyQ9AeZZhguYf1T": {
        "decimals": 9,
        "symbol": "Anon"
    },
    "TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6": {
        "decimals": 9,
        "symbol": "TNSR"
    },
    "Sg4k4iFaEeqhv5866cQmsFTMhRx8sVCPAq2j8Xcpump": {
        "decimals": 6,
        "symbol": "SPSN"
    },
    "HmjvebVDmhB346ZGgMJNdx9NUAF8EVogdFBSj7wdn3ix": {
        "decimals": 8,
        "symbol": null
    },
    "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v": {
        "decimals": 9,
        "symbol": "JupSOL"
    },
    "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm": {
        "decimals": 9,
        "symbol": "INF"
    },
    "myrcAs6bpP2g5oGHZ3qpgrfZQAFkbo9KUHdqYDXMjGv": {
        "decimals": 6,
        "symbol": "MYRC"
    },
    "SCSuPPNUSypLBsV4darsrYNg4ANPgaGhKhsA3GmMyjz": {
        "decimals": 5,
        "symbol": "SCS"
    },
    "2oQNkePakuPbHzrVVkQ875WHeewLHCd2cAwfwiLQbonk": {
        "decimals": 6,
        "symbol": "AOL"
    },
    "Cy1GS2FqefgaMbi45UunrUzin1rfEmTUYnomddzBpump": {
        "decimals": 6,
        "symbol": "MOBY"
    },
    "HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz": {
        "decimals": 6,
        "symbol": "sHYUSD"
    },
    "vQoYWru2pbUdcVkUrRH74ktQDJgVjRcDvsoDbUzM5n9": {
        "decimals": 4,
        "symbol": "REKT"
    },
    "Ee4ooSk6GMC34T1Gbh8rRY2XLyuk2FsyiWtq3jrHUcPR": {
        "decimals": 9,
        "symbol": "VNX"
    },
    "H5b4iYiZYycr7fmQ1dMj7hdfLGAEPcDH261K4hugpump": {
        "decimals": 6,
        "symbol": "MONEROCHAN"
    },
    "AyrQpt5xsVYiN4BqgZdd2tZJAWswT9yLUZmP1jKqpump": {
        "decimals": 6,
        "symbol": "jobcoin"
    },
    "STREAMribRwybYpMmSYoCsQUdr6MZNXEqHgm7p1gu9M": {
        "decimals": 6,
        "symbol": "STREAM"
    },
    "GEuuznWpn6iuQAJxLKQDVGXPtrqXHNWTk3gZqqvJpump": {
        "decimals": 6,
        "symbol": "ACE"
    },
    "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj": {
        "decimals": 6,
        "symbol": "syrupUSDC"
    },
    "PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta": {
        "decimals": 6,
        "symbol": "UMBRA"
    },
    "31k88G5Mq7ptbRDf3AM13HAq6wRQHXHikR8hik7wPygk": {
        "decimals": 9,
        "symbol": "GP"
    },
    "9wK8yN6iz1ie5kEJkvZCTxyN1x5sTdNfx8yeMY8Ebonk": {
        "decimals": 6,
        "symbol": "Hosico"
    },
    "69LjZUUzxj3Cb3Fxeo1X4QpYEQTboApkhXTysPpbpump": {
        "decimals": 6,
        "symbol": "CODEC"
    },
    "CxiR3c9AGqMtE7bg82sLnzpLinXN3kXfcoYeYtGApFoG": {
        "decimals": 6,
        "symbol": "FOG"
    },
    "BktHEAc2WS8TQi2vmavn1rA4L1WJuwF3Vkk3DnwwARti": {
        "decimals": 9,
        "symbol": null
    },
    "Ex5DaKYMCN6QWFA4n67TmMwsH8MJV68RX6YXTmVM532C": {
        "decimals": 9,
        "symbol": "USDv"
    },
    "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg": {
        "decimals": 8,
        "symbol": "zBTC"
    },
    "BivtZFQ5mVdjMM3DQ8vxzvhKKiVs27fz1YUF8bRFdKKc": {
        "decimals": 9,
        "symbol": "FLAME"
    },
    "GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG": {
        "decimals": 9,
        "symbol": "CROWN"
    },
    "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp": {
        "decimals": 6,
        "symbol": "CARDS"
    },
    "CaAkNuMqWc87arZ7Aw8wp82K34SxtAf2J6uR7VW47cmU": {
        "decimals": 9,
        "symbol": null
    },
    "Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu": {
        "decimals": 6,
        "symbol": "PUMPCADE"
    },
    "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2": {
        "decimals": 6,
        "symbol": "TROLL"
    },
    "9v6BKHg8WWKBPTGqLFQz87RxyaHHDygx8SnZEbBFmns2": {
        "decimals": 9,
        "symbol": "SKATE"
    },
    "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": {
        "decimals": 9,
        "symbol": "POPCAT"
    },
    "J9BcrQfX4p9D1bvLzRNCbMDv8f44a9LFdeqNE4Yk2WMD": {
        "decimals": 6,
        "symbol": "ISC"
    },
    "3dQTr7ror2QPKQ3GbBCokJUmjErGg8kTJzdnYjNfvi3Z": {
        "decimals": 9,
        "symbol": "BORG"
    },
    "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn": {
        "decimals": 8,
        "symbol": "xBTC"
    },
    "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": {
        "decimals": 9,
        "symbol": "JTO"
    },
    "AGRidUXLeDij9CJprkZx7WBXtTQC67jtfiwz293mVrJ": {
        "decimals": 6,
        "symbol": "AGRI"
    },
    "H8xQ6poBjB9DTPMDTKWzWPrnxu4bDEhybxiouF8Ppump": {
        "decimals": 6,
        "symbol": "Tokabu"
    },
    "CPLTbYbtDMKZtHBaPqdDmHjxNwESCEB14gm6VuoDpump": {
        "decimals": 6,
        "symbol": "DTV"
    },
    "SNS8DJbHc34nKySHVhLGMUUE72ho6igvJaxtq9T3cX3": {
        "decimals": 5,
        "symbol": "SNS"
    },
    "CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump": {
        "decimals": 6,
        "symbol": "USDUC"
    },
    "JDzPbXboQYWVmdxXS3LbvjM52RtsV1QaSv2AzoCiai2o": {
        "decimals": 6,
        "symbol": "FO"
    },
    "FeR8VBqNRSUD5NtXAj2n3j1dAHkZHfyDktKuLXD4pump": {
        "decimals": 6,
        "symbol": "jellyjelly"
    },
    "E7NgL19JbN8BhUDgWjkH8MtnbhJoaGaWJqosxZZepump": {
        "decimals": 6,
        "symbol": "PAYAI"
    },
    "CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu": {
        "decimals": 9,
        "symbol": "CLOUD"
    },
    "63bpnCja1pGB2HSazkS8FAPAUkYgcXoDwYHfvZZveBot": {
        "decimals": 6,
        "symbol": "BOT"
    },
    "5HsZR8eG7QpQcN8Mnp8oFdENRkJMP9ZkcKhPSCKTJSWh": {
        "decimals": 9,
        "symbol": "MRC"
    },
    "9mQEkFVqmRJLMPUJT25qriKXi2sH8RiuMBrzLeLupump": {
        "decimals": 6,
        "symbol": null
    },
    "BFgdzMkTPdKKJeTipv2njtDEwhKxkgFueJQfJGt1jups": {
        "decimals": 6,
        "symbol": "URANUS"
    },
    "8EHC2gfTLDb2eGQfjm17mVNLWPGRc9YVD75bepZ2nZJa": {
        "decimals": 9,
        "symbol": null
    },
    "GkyPYa7NnCFbduLknCfBfP7p8564X1VZhwZYJ6CZpump": {
        "decimals": 6,
        "symbol": "CHILLHOUSE"
    },
    "8zFovnzXzK9JDiftGaw7wiRxARrRtvm9Lz12vJ8CZ5ZA": {
        "decimals": 5,
        "symbol": null
    },
    "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E": {
        "decimals": 6,
        "symbol": "hyUSD"
    },
    "DEJqUhPTarcaNqhT7c6fktUszcJWN6skqyWSxXchpJNm": {
        "decimals": 6,
        "symbol": "MATTLE"
    },
    "Jambjx1oJoZNBZiqbiF9TqgatEZPdyfvYa9WVsKNzUh": {
        "decimals": 9,
        "symbol": "J"
    },
    "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9": {
        "decimals": 5,
        "symbol": "GIGA"
    },
    "3VW31dwix6k2EdzhDgZ2zB15J7FbHYQwAUqXgktRcJEX": {
        "decimals": 6,
        "symbol": "SOLPUMP"
    },
    "SENDdRQtYMWaQrBroBrJ2Q53fgVuq95CV9UPGEvpCxa": {
        "decimals": 6,
        "symbol": "SEND"
    },
    "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P": {
        "decimals": 6,
        "symbol": "MELANIA"
    },
    "sSo14endRuUbvQaJS3dq36Q829a3A6BEfoeeRGJywEh": {
        "decimals": 9,
        "symbol": "sSOL"
    },
    "5VsPJ2EG7jjo3k2LPzQVriENKKQkNUTzujEzuaj4Aisf": {
        "decimals": 6,
        "symbol": "ROCK"
    },
    "WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk": {
        "decimals": 5,
        "symbol": "WEN"
    },
    "DVYcTNFVGxePLgK8rUjViJvurRmTnD1FZUBR7puADymT": {
        "decimals": 9,
        "symbol": "DVY"
    },
    "Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU": {
        "decimals": 6,
        "symbol": "LIBRA"
    },
    "4Qur8tvJG195EXmhsuPvpa3qmMiAugtbDaoGwVGV6oJD": {
        "decimals": 6,
        "symbol": null
    },
    "AxGAbdFtdbj2oNXa4dKqFvwHzgFtW9mFHWmd7vQfpump": {
        "decimals": 6,
        "symbol": "HAT"
    },
    "C29ebrgYjYoJPMGPnPSGY1q3mMGk4iDSqnQeQQA7moon": {
        "decimals": 9,
        "symbol": "NOBODY"
    },
    "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1": {
        "decimals": 9,
        "symbol": "bSOL"
    },
    "omfgRBnxHsNJh6YeGbGAmWenNkenzsXyBXm3WDhmeta": {
        "decimals": 6,
        "symbol": "OMFG"
    },
    "GtDZKAqvMZMnti46ZewMiXCa4oXF4bZxwQPoKzXPFxZn": {
        "decimals": 9,
        "symbol": "nub"
    },
    "6D7NaB2xsLd7cauWu1wKk6KBsJohJmP2qZH9GEfVi5Ui": {
        "decimals": 6,
        "symbol": "SC"
    },
    "HhCLbkW6FwhriTkk81W8tYstsRCLUu6Y7Je1SQjVpump": {
        "decimals": 6,
        "symbol": "KIKI"
    },
    "7xYbBLdju4UixjnQuMCb9Rzh3NrtuqUnymgUubAMQZdK": {
        "decimals": 9,
        "symbol": null
    },
    "HAY3ZXFGUEaQLM1rnxHATU64n7c32PAyQ9CnvYxfZR4Q": {
        "decimals": 9,
        "symbol": "HayekSOL"
    },
    "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs": {
        "decimals": 6,
        "symbol": "xSOL"
    },
    "yUSDX7W89jXWn4zzDPLnhykDymSjQSmpaJ8e4fjC1fg": {
        "decimals": 6,
        "symbol": "yUSD"
    },
    "AQYSxfK5N9gDV6gtqXig5s43QVTkAKbHKpCMGjw8WRgQ": {
        "decimals": 6,
        "symbol": null
    },
    "FQgtfugBdpFN7PZ6NdPrZpVLDBrPGxXesi4gVu3vErhY": {
        "decimals": 9,
        "symbol": "BMT"
    },
    "8J69rbLTzWWgUJziFY8jeu5tDwEPBwUz4pKBMr5rpump": {
        "decimals": 6,
        "symbol": "WOJAK"
    },
    "G85CQEBqwsoe3qkb5oXXpdZFh7uhYXhDRsQAM4aJuBLV": {
        "decimals": 9,
        "symbol": "ORGO"
    },
    "vRseBFqTy9QLmmo5qGiwo74AVpdqqMTnxPqWoWMpump": {
        "decimals": 6,
        "symbol": "Verse"
    },
    "FkiJSGKDMjRip1MFKa4bxVUtZBA2hkpBHdTfEW8E4iQj": {
        "decimals": 6,
        "symbol": "ANB"
    },
    "9223LqDuoJXyhCtvi54DUQPGS8Xf29kUEQRr7Sfhmoon": {
        "decimals": 9,
        "symbol": "LOOK"
    },
    "vEHiuRmd8WvCkswH8Xy4VXTEMXA7JScik47XZkDbonk": {
        "decimals": 6,
        "symbol": "ROI"
    },
    "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS": {
        "decimals": 6,
        "symbol": "KMNO"
    },
    "DuMbhu7mvQvqQHGcnikDgb4XegXJRyhUBfdU22uELiZA": {
        "decimals": 9,
        "symbol": "elizaOS"
    },
    "J3umBWqhSjd13sag1E1aUojViWvPYA5dFNyqpKuX3WXj": {
        "decimals": 9,
        "symbol": "HOME"
    },
    "k9D9mMmGU2ofo5EF8w5oVQHRpXbC2wAQcZvyzhsxPAR": {
        "decimals": 9,
        "symbol": null
    },
    "LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY": {
        "decimals": 8,
        "symbol": "LBTC"
    },
    "DuEy8wWrzCUun5ZbbG9hkVqXqqicpTQw8gB7nEAzpCHQ": {
        "decimals": 9,
        "symbol": "FLUID"
    },
    "6yjNqPzTSanBWSa6dxVEgTjePXBrZ2FoHLDQwYwEsyM6": {
        "decimals": 6,
        "symbol": "Chud"
    },
    "5JkQBPrYdRK7JsC39KPPbZi7r6uLx3ZuL7jjMf4zN4c": {
        "decimals": 9,
        "symbol": "UCF"
    },
    "FfixAeHevSKBZWoXPTbLk4U4X9piqvzGKvQaFo3cpump": {
        "decimals": 6,
        "symbol": "POLYFACTS"
    },
    "GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A": {
        "decimals": 6,
        "symbol": "GOLD"
    },
    "DSujpGT7Td9AVr8wRiZ5dQzXyRB8p9vV5maZuJf3TK8a": {
        "decimals": 6,
        "symbol": null
    },
    "fRfKGCriduzDwSudCwpL7ySCEiboNuryhZDVJtr1a1C": {
        "decimals": 9,
        "symbol": "DUPE"
    },
    "4yCLi5yWGzpTWMQ1iWHG5CrGYAdBkhyEdsuSugjDUqwj": {
        "decimals": 6,
        "symbol": "ALP"
    },
    "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta": {
        "decimals": 6,
        "symbol": "ZKFG"
    },
    "1zJX5gRnjLgmTpq5sVwkq69mNDQkCemqoasyjaPW6jm": {
        "decimals": 9,
        "symbol": "KLED"
    },
    "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g": {
        "decimals": 9,
        "symbol": "HYPE"
    },
    "GENEtH5amGSi8kHAtQoezp1XEXwZJ8vcuePYnXdKrMYz": {
        "decimals": 9,
        "symbol": "GENE"
    },

    "8Ne5fhU1B7RuBB6v3GhJ9ixuLUJYcRfP9MCEhCuNtsss": {
        "decimals": 6,
        "symbol": "BUILD"
    },
    "uniBKsEV37qLRFZD7v3Z9drX6voyiCM8WcaePqeSSLc": {
        "decimals": 8,
        "symbol": null
    },
    "6kwTqmdQkJd8qRr9RjSnUX9XJ24RmJRSrU1rsragP97Y": {
        "decimals": 6,
        "symbol": "SAIL"
    },
    "4Cnk9EPnW5ixfLZatCPJjDB1PUtcRpVVgTQukm9epump": {
        "decimals": 6,
        "symbol": "DADDY"
    },
    "9doRRAik5gvhbEwjbZDbZR6GxXSAfdoomyJR57xKpump": {
        "decimals": 6,
        "symbol": "GRPH"
    },
    "dog1viwbb2vWDpER5FrJ4YFG6gq6XuyFohUe9TXN65u": {
        "decimals": 5,
        "symbol": "DOG"
    },
    "JxxWsvm9jHt4ah7DT9NuLyVLYZcZLUdPD93PcPQ71Ka": {
        "decimals": 9,
        "symbol": "mockJUP"
    },
    "DYeTA4ZQhEwoJ5imjq1Q3zgwfTgkh4WmdfFHAq3jLrv3": {
        "decimals": 6,
        "symbol": "USDAI"
    }
};
const TOKENS_DECIMALS = TOKEN_DECIMALS;
/*
// Combine all token objects into one master TOKEN_DECIMALS object
const TOKEN_DECIMALS = {
    ...SOL,
    ...STABLE,
    ...DEFI
};
*/
/**
 * Get token decimals by mint address
 * @param {string} mint - Token mint address
 * @returns {number|null} Token decimals or null if not found
 */
function getTokenDecimals(mint) {
    const token = TOKEN_DECIMALS[mint];
    if (!token) return null;
    if (typeof token === 'number') return token;
    if (typeof token === 'object' && token.decimals !== undefined) return token.decimals;
    return null;
}

/**
 * Get token symbol by mint address
 * @param {string} mint - Token mint address
 * @returns {string|null} Token symbol or null if not found
 */
function getTokenSymbol(mint) {
    const token = TOKEN_DECIMALS[mint];
    if (!token) return null;

    if (typeof token === 'string') return token;
    return typeof token === 'object' ? token.symbol : null;
}

class DecimalUtil {
    static fromU64(input, shift = 0) {
        return new decimal_js_1.default(input.toString()).div(new decimal_js_1.default(10).pow(shift));
    }
    static toU64(input, shift = 0) {
        if (input.isNeg()) {
            throw new Error("Negative decimal value ${input} cannot be converted to u64.");
        }
        const shiftedValue = input.mul(new decimal_js_1.default(10).pow(shift));
        const zeroDecimalValue = shiftedValue.trunc();
        return new spl_token_1.u64(zeroDecimalValue.toString());
    }
}
exports.DecimalUtil = DecimalUtil;

/**
 * Get complete token info (decimals + symbol)
 * @param {string} mint - Token mint address
 * @returns {{decimals: number, symbol: string|null}|null} Token info or null
 */
function getTokenInfo(mint) {
    const token = TOKEN_DECIMALS[mint];
    if (!token) return null;

    // Handle both formats
    if (typeof token === 'number') {
        return { decimals: token, symbol: null };
    }
    return token;
}

/**
 * Check if token decimals are cached
 * @param {string} mint - Token mint address
 * @returns {boolean} True if decimals are cached
 */
function hasTokenDecimals(mint) {
    return mint in TOKEN_DECIMALS;
}

/**
 * Get all cached token mints
 * @returns {string[]} Array of token mint addresses
 */
function getAllCachedMints() {
    return Object.keys(TOKEN_DECIMALS);
}

/**
 * Get all tokens with symbols
 * @returns {Array<{mint: string, decimals: number, symbol: string}>} Array of tokens with symbols
 */
function getTokensWithSymbols() {
    return Object.entries(TOKEN_DECIMALS)
        .filter(([_, token]) => typeof token === 'object' && token.symbol)
        .map(([mint, token]) => ({
            mint,
            decimals: token.decimals,
            symbol: token.symbol
        }));
}

function main() {
    const short = (s) => `${s.slice(0, 6)}..${s.slice(-4)}`;
    const entries = Object.entries(TOKEN_DECIMALS);
    const rows = entries.map(([mint, info]) => {
        const decimals = typeof info === 'number' ? info : info.decimals;
        const symbol = getTokenSymbol(mint) || short(mint);
        const isResolved = symbol !== short(mint);
        return { symbol, decimals, mint: `${mint.slice(0, 6)}..${mint.slice(-4)}`, fullMint: mint, resolved: isResolved };
    });
    rows.sort((a, b) => (b.resolved - a.resolved) || a.symbol.localeCompare(b.symbol));

    console.log(`\n  Token Registry: ${entries.length} tokens\n`);
    console.log(`  ${'SYMBOL'.padEnd(14)} ${'DEC'.padEnd(5)} MINT`);
    console.log(`  ${'─'.repeat(14)} ${'─'.repeat(5)} ${'─'.repeat(14)}`);
    for (const row of rows) {
        console.log(`  ${row.symbol.padEnd(14)} ${String(row.decimals).padEnd(5)} ${row.mint}`);
    }

    const unresolved = rows.filter(r => !r.resolved);
    if (unresolved.length) {
        console.log(`\n  ${unresolved.length} token(s) have no symbol (showing abbreviated mint as name)`);
    }
}

if (require.main === module) main();

module.exports = {
    TOKEN_DECIMALS,
    TOKENS_DECIMALS,
    getTokenDecimals,
    getTokenSymbol,
    getTokenInfo,
    hasTokenDecimals,
    getAllCachedMints,
    getTokensWithSymbols
};


/*
//. node utilities/defiTok.js



{
"type": "...",
"dex": "...",
"name": "...",
"symbol": "...",
"decimals": "...",
"totalSupply": "...",
"ownerAddress": "...",
"mintAddress": "..."
}
]

*/
