// Use supported public package entrances rather than the legacy compatibility
// facade: this app needs one Memo, not loader, staking or system-program clients.
export { address } from '@solana/addresses';
export { AccountRole } from '@solana/instructions';
export { createSolanaRpc } from '@solana/rpc';
export {
  generateKeyPairSigner,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners
} from '@solana/signers';
export {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  setTransactionMessageLifetimeUsingBlockhash
} from '@solana/transaction-messages';
export {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction
} from '@solana/transactions';
