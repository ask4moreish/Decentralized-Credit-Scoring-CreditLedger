# Stellar Testnet Deployment & On-Chain Verification Evidence

> Executed live against Stellar Testnet Soroban RPC (`https://soroban-testnet.stellar.org`) and Horizon (`https://horizon-testnet.stellar.org`) via [`scripts/testnet-deploy-and-verify.mjs`](scripts/testnet-deploy-and-verify.mjs). Machine-readable manifest: [`contracts/deployed-testnet-hardened.json`](contracts/deployed-testnet-hardened.json).

## 1. Preserved Legacy Prototype Contracts (Unmodified)

These legacy contract IDs remain untouched on Testnet for historical provenance:
- Legacy `CreditScore`: `CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ`
- Legacy `LoanManager`: `CDO44SYFPU7SCP4BFTJTWFL2Z7BDB4MVOSSUSW6JUXSPB37ZIAZ7FHKA`
- Legacy `CommunityVouch`: `CCZNGFWUX5YFTRP7Y2N7I4TFTNS6YV4243NZ62LLQXGSXLIQTB2XP552`

---

## 2. Hardened v2 Testnet Contracts (`wasm32v1-none`)

| Contract | Deployed Contract ID | WASM SHA-256 | Size | Explorer |
| --- | --- | --- | --- | --- |
| `CreditScore` | `CAAPEEPQJH5ZQHOYOF3KVHQNUGZV5DVPUSE4KCAKJ3E3NQGEYQ53ZUTW` | `bcfa972318fe9b923650512190824453451c411a51efc9ec7e041d35bd5f0fca` | `33,992 B` | [View Contract](https://stellar.expert/explorer/testnet/contract/CAAPEEPQJH5ZQHOYOF3KVHQNUGZV5DVPUSE4KCAKJ3E3NQGEYQ53ZUTW) |
| `LoanManager` | `CB4KYCG62B62RNMIGHV2NP5GDCGPGE23XW5FQVOTBE266PFPKKB5NNXB` | `b27c238fd35905f23a74be63cd6edf2b9c5f62ab0ae277ea157b53ab19a0b363` | `36,953 B` | [View Contract](https://stellar.expert/explorer/testnet/contract/CB4KYCG62B62RNMIGHV2NP5GDCGPGE23XW5FQVOTBE266PFPKKB5NNXB) |
| `CommunityVouch` | `CAQSXBETHWHNXF5BJV37CVD2AI4D4JTVZ3J2S3YLTAPUF5V7BWFV444F` | `4999127b24c868c988b3bc7838d423932afdc7cdfdf9a7c643f768aa032c5f6e` | `28,142 B` | [View Contract](https://stellar.expert/explorer/testnet/contract/CAQSXBETHWHNXF5BJV37CVD2AI4D4JTVZ3J2S3YLTAPUF5V7BWFV444F) |
| Native XLM SAC | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | Protocol Native SAC | — | [View Asset Contract](https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC) |

Timestamp: `2026-11-11T20:16:58.148Z` | Horizon check: `VERIFIED_ON_HORIZON`

---

## 3. Ephemeral Test Actors (Public Addresses Only — No Secrets Retained)

- `admin`: `GDRPNHE5VHFZXKBXA2OWHQ3X4TWBRPWRLNKVVQ7PXVEZ2X4NS5YJIMHH`
- `issuer`: `GC3BCZMZ7RZEU3BIYMTMF63EQLT3MTKYBBESEORZSV6SD74F3WKIO5CH`
- `lender`: `GDATYKO7VNHVAJD5CSWZ3YCISFZRVAWNE27DLSVUCDFLXEGJ2FAZALMW`
- `borrower`: `GB3WTSQ3LT3CPBUDF3DIFLQAI4OE4IJS27IMHHJZGZZH3SOIWYVI5CIB`
- `borrower2Collateralized`: `GAB2WYFJQD3YJFDXSSH3D37CO6BXKZAHYBJ5XDN6FDEVG6K43HG2GDHB`
- `voucher`: `GBZXRZ4OX5JHWTPIRITH3CL6TX35DQ6OGEDGZXGHMVWOZ37TZFSCLEFM`

---

## 4. Negative Security Controls Verified on Testnet

1. **Re-initialization Rejected (Simulation)**: Calling `CreditScore.initialize(borrower)` post-initialization rejected (`AlreadyInitialized`).
2. **Unauthorized Issuer Registration Rejected (Live Submission)**: Submitting `CreditScore.register_issuer(...)` signed only by `borrower` (without admin authorization) failed on ledger `#5680890` (`tx=a3bdbb4a447b26e795da15abf0e1bcf78bb6c1ae8aa3fab517584b2fead09ebb`).
3. **Self-Reported Zero-Weight Check**: Confirming `submit_self_reported_record` (`tx=001e7a1a344a36c7b7b8ac11e452b6bf53f653ef21bcf984e965ef3e1a92860c`, ledger `#5680892`) left authoritative `get_credit_score` at `0`.
4. **Premature Default Liquidation Rejected (Simulation)**: Simulating `LoanManager.mark_default` on active `loan #3` prior to `due_date` rejected (`LoanNotYetDue`).

> Note: Forced overdue timestamp default liquidation & bounded vouch slashing were verified via local Soroban ledger-timestamp simulation tests (`test_late_fee_default_liquidation_with_surplus_refund_and_vouch_slash`, `test_trust_decay_cooldown_expiry_and_bounded_default_slashing`), since Testnet wall-clock time cannot be warped past a 3–6 month loan maturity window in real time.

---

## 5. Confirmed On-Chain Transactions (`36` Successes, Ledgers `5680877`–`5680914`)

| Step | Ledger | Full Transaction Hash | Explorer |
| --- | --- | --- | --- |
| `upload_wasm_creditScore` | `5680877` | `d5e2433bff8922b637a3d32f48eb287594fc5e78777e59ffb788a200ed5085a1` | [Tx](https://stellar.expert/explorer/testnet/tx/d5e2433bff8922b637a3d32f48eb287594fc5e78777e59ffb788a200ed5085a1) |
| `deploy_creditScore` | `5680878` | `2dcb5416dbcc87276519d46bf97196c7cb20a4bd28f2737412edf4fcf5d6628f` | [Tx](https://stellar.expert/explorer/testnet/tx/2dcb5416dbcc87276519d46bf97196c7cb20a4bd28f2737412edf4fcf5d6628f) |
| `upload_wasm_loanManager` | `5680879` | `d56677dd4c362b4c1d0bb21ee87de8db581aa81fb8cdae88c62385b829a16fb5` | [Tx](https://stellar.expert/explorer/testnet/tx/d56677dd4c362b4c1d0bb21ee87de8db581aa81fb8cdae88c62385b829a16fb5) |
| `deploy_loanManager` | `5680880` | `b6586bfd27bee8a807835e88c8415986eac822ad4a2b6ea00bb80f22047f2369` | [Tx](https://stellar.expert/explorer/testnet/tx/b6586bfd27bee8a807835e88c8415986eac822ad4a2b6ea00bb80f22047f2369) |
| `upload_wasm_communityVouch` | `5680881` | `d6254b338577b16fdc820678af94a39865ec70e6a4830361fb14078b7a8df5b5` | [Tx](https://stellar.expert/explorer/testnet/tx/d6254b338577b16fdc820678af94a39865ec70e6a4830361fb14078b7a8df5b5) |
| `deploy_communityVouch` | `5680882` | `b13ef761f5cadbc1ef2a45c5a5fb14866f91e28d8bff4cfb4642f99d475de45a` | [Tx](https://stellar.expert/explorer/testnet/tx/b13ef761f5cadbc1ef2a45c5a5fb14866f91e28d8bff4cfb4642f99d475de45a) |
| `credit_score.initialize` | `5680883` | `47902b5aa55d1140b0364a84b8ada1ac7c639297c52bf5f153b9da7ecf7262e2` | [Tx](https://stellar.expert/explorer/testnet/tx/47902b5aa55d1140b0364a84b8ada1ac7c639297c52bf5f153b9da7ecf7262e2) |
| `community_vouch.initialize` | `5680884` | `8774bb6cf9259843b099e124582c3d52dba56e211abf751c4c7a4b97866c11a6` | [Tx](https://stellar.expert/explorer/testnet/tx/8774bb6cf9259843b099e124582c3d52dba56e211abf751c4c7a4b97866c11a6) |
| `loan_manager.initialize` | `5680885` | `1f2c4e9b0b56444342b1e94f1fc3234482f30eed32b72b105f06509ffbbdffac` | [Tx](https://stellar.expert/explorer/testnet/tx/1f2c4e9b0b56444342b1e94f1fc3234482f30eed32b72b105f06509ffbbdffac) |
| `credit_score.set_loan_manager_contract` | `5680886` | `90fb5c1626646a1954fdf3192e2c7ba802391be064294c79468ee5b6b0035e76` | [Tx](https://stellar.expert/explorer/testnet/tx/90fb5c1626646a1954fdf3192e2c7ba802391be064294c79468ee5b6b0035e76) |
| `credit_score.set_community_vouch_contract` | `5680887` | `631a10401ef4197a2e70a86c0d2ba4247aba8057f3e870938b6443015e0e0aac` | [Tx](https://stellar.expert/explorer/testnet/tx/631a10401ef4197a2e70a86c0d2ba4247aba8057f3e870938b6443015e0e0aac) |
| `community_vouch.set_loan_manager_contract` | `5680888` | `c8e419e8049c3ce615c1bb7156c03eb8c7492738a98430ed3a153b63a2569d6f` | [Tx](https://stellar.expert/explorer/testnet/tx/c8e419e8049c3ce615c1bb7156c03eb8c7492738a98430ed3a153b63a2569d6f) |
| `loan_manager.set_community_vouch_contract` | `5680889` | `7d2bc6cc764e457199f29fb327e1c1068859059c0338aad2e4e18306595bce56` | [Tx](https://stellar.expert/explorer/testnet/tx/7d2bc6cc764e457199f29fb327e1c1068859059c0338aad2e4e18306595bce56) |
| `register_issuer` | `5680891` | `7c2f04471d59701a5f8320900b65e73b1995512c5256f256bbce7058d9486a75` | [Tx](https://stellar.expert/explorer/testnet/tx/7c2f04471d59701a5f8320900b65e73b1995512c5256f256bbce7058d9486a75) |
| `submit_self_reported_record` | `5680892` | `001e7a1a344a36c7b7b8ac11e452b6bf53f653ef21bcf984e965ef3e1a92860c` | [Tx](https://stellar.expert/explorer/testnet/tx/001e7a1a344a36c7b7b8ac11e452b6bf53f653ef21bcf984e965ef3e1a92860c) |
| `submit_signed_attestation_payment` | `5680893` | `534d327b4ddc25cbf912818a29c052d03f386c77256e7da816583c8f1aef8510` | [Tx](https://stellar.expert/explorer/testnet/tx/534d327b4ddc25cbf912818a29c052d03f386c77256e7da816583c8f1aef8510) |
| `submit_signed_attestation_savings` | `5680894` | `01d5032b1baf06ad9ad6d2d01844f1d53c57838053cfb4bec3eb62285a11e2c1` | [Tx](https://stellar.expert/explorer/testnet/tx/01d5032b1baf06ad9ad6d2d01844f1d53c57838053cfb4bec3eb62285a11e2c1) |
| `voucher_attested_payment` | `5680895` | `ddc680b9084586e211a13eb81e494126a3832e8c2a5c7a472afbc4a95ce6235b` | [Tx](https://stellar.expert/explorer/testnet/tx/ddc680b9084586e211a13eb81e494126a3832e8c2a5c7a472afbc4a95ce6235b) |
| `voucher_attested_savings` | `5680896` | `c006fbb5bba202c5af4d70822b0b874dbfc9f91b390597b4fe84a5243feeeffc` | [Tx](https://stellar.expert/explorer/testnet/tx/c006fbb5bba202c5af4d70822b0b874dbfc9f91b390597b4fe84a5243feeeffc) |
| `community_vouch.create_vouch` (50 XLM escrow, borrower score -> 83) | `5680897` | `18e497fd04f7fc09ae5bfa4c982fca46da4e43d3c1cfcb356d09dff33e5f198b` | [Tx](https://stellar.expert/explorer/testnet/tx/18e497fd04f7fc09ae5bfa4c982fca46da4e43d3c1cfcb356d09dff33e5f198b) |
| `loan_manager.deposit_liquidity` (300 XLM SAC) | `5680898` | `cd02c21d6dbab1124fc04d633aa665a39b77584e8a1a706ed7a9b679f3052d4b` | [Tx](https://stellar.expert/explorer/testnet/tx/cd02c21d6dbab1124fc04d633aa665a39b77584e8a1a706ed7a9b679f3052d4b) |
| `loan_manager.create_loan` (100 XLM) | `5680899` | `d00da5b6c1e0585b8ad5e98d8c14f03eec25b08e2272c924df44893bf318588f` | [Tx](https://stellar.expert/explorer/testnet/tx/d00da5b6c1e0585b8ad5e98d8c14f03eec25b08e2272c924df44893bf318588f) |
| `loan_manager.approve_loan` (disburse 100 XLM) | `5680900` | `3dd1ba506dcb7869c5819d1db717bed69b84660d79a13d85d7f5d58e0d554921` | [Tx](https://stellar.expert/explorer/testnet/tx/3dd1ba506dcb7869c5819d1db717bed69b84660d79a13d85d7f5d58e0d554921) |
| `loan_manager.repay_loan` (principal + 8% APR) | `5680901` | `5f944c04353764a953728f796a4d5328279635d9568bba5a0075e90f941e6da0` | [Tx](https://stellar.expert/explorer/testnet/tx/5f944c04353764a953728f796a4d5328279635d9568bba5a0075e90f941e6da0) |
| `loan_manager.withdraw_liquidity` (principal + interest yield) | `5680902` | `cad0b4f59b32c2ad1ac5e8f6dcb8cebe26af9bbfd11b681a5a88d7ae8de847f1` | [Tx](https://stellar.expert/explorer/testnet/tx/cad0b4f59b32c2ad1ac5e8f6dcb8cebe26af9bbfd11b681a5a88d7ae8de847f1) |
| `b2_attest_payment` | `5680904` | `4e00d5219844ae42df287e39c5add6604e9e2e89b752de020e74578e8e0f5b57` | [Tx](https://stellar.expert/explorer/testnet/tx/4e00d5219844ae42df287e39c5add6604e9e2e89b752de020e74578e8e0f5b57) |
| `b2_attest_savings` | `5680905` | `d8ff1326effb15fb85934696b2fc77569c2875ac7e227187babda385e16215c8` | [Tx](https://stellar.expert/explorer/testnet/tx/d8ff1326effb15fb85934696b2fc77569c2875ac7e227187babda385e16215c8) |
| `community_vouch.create_vouch_b2` (20 XLM) | `5680906` | `ceb3b8665978f52da381fb5781d31be1ddec03ff7c6778ff9568f4173976df7a` | [Tx](https://stellar.expert/explorer/testnet/tx/ceb3b8665978f52da381fb5781d31be1ddec03ff7c6778ff9568f4173976df7a) |
| `community_vouch.revoke_vouch_1` (escrow refund) | `5680907` | `04ae505d33683cc196672285cf3f9c192a0a8de68ba00db3fd628996149d0e77` | [Tx](https://stellar.expert/explorer/testnet/tx/04ae505d33683cc196672285cf3f9c192a0a8de68ba00db3fd628996149d0e77) |
| `community_vouch.revoke_vouch_2` (escrow refund) | `5680908` | `7a7a3572e4af91f7d19629001c94b4a2ea021ba45a0ab04d12610107fca3e435` | [Tx](https://stellar.expert/explorer/testnet/tx/7a7a3572e4af91f7d19629001c94b4a2ea021ba45a0ab04d12610107fca3e435) |
| `loan_manager.redeposit_for_collateral_test` (60 XLM) | `5680909` | `f5f4e058115a3698ebd0530c6dd3e9e1107dddda882ca2a5559dcc2211a2621b` | [Tx](https://stellar.expert/explorer/testnet/tx/f5f4e058115a3698ebd0530c6dd3e9e1107dddda882ca2a5559dcc2211a2621b) |
| `loan_manager.create_loan_cancel_test` (50 XLM collateral lock) | `5680910` | `7036f53e3690b10839c8fcc0334ec973613d5a9e3a81654f36e8df154dd3616b` | [Tx](https://stellar.expert/explorer/testnet/tx/7036f53e3690b10839c8fcc0334ec973613d5a9e3a81654f36e8df154dd3616b) |
| `loan_manager.cancel_loan_refund_collateral` | `5680911` | `016cd90c1a0fa777a60e8d92d07e49ff1b2c0fb8c6ff227f3f1a3469e7bd2bcb` | [Tx](https://stellar.expert/explorer/testnet/tx/016cd90c1a0fa777a60e8d92d07e49ff1b2c0fb8c6ff227f3f1a3469e7bd2bcb) |
| `loan_manager.create_collateral_loan_2` (40 XLM + 50 XLM collateral) | `5680912` | `bd120d87f7d7496ece1cbaa891051ad03d9419e72199c0c9f24bd15cf8515de3` | [Tx](https://stellar.expert/explorer/testnet/tx/bd120d87f7d7496ece1cbaa891051ad03d9419e72199c0c9f24bd15cf8515de3) |
| `loan_manager.approve_loan_2` | `5680913` | `40b0825fad963b92ae1264fc0de9a3a2a4f908d422b4620857271e9c429ef9e8` | [Tx](https://stellar.expert/explorer/testnet/tx/40b0825fad963b92ae1264fc0de9a3a2a4f908d422b4620857271e9c429ef9e8) |
| `loan_manager.repay_collateral_loan_2` (collateral unlocked) | `5680914` | `b4d796597284d97de6984bf7570df7f5c069e106cd258acd447ed3a32a28b6c0` | [Tx](https://stellar.expert/explorer/testnet/tx/b4d796597284d97de6984bf7570df7f5c069e106cd258acd447ed3a32a28b6c0) |
