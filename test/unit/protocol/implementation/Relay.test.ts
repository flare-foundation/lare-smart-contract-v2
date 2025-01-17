import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { constants, expectEvent, expectRevert } from "@openzeppelin/test-helpers";
import { artifacts, config, contract, ethers } from "hardhat";
import { HardhatNetworkAccountConfig } from "hardhat/types";
import { RelayInitialConfig } from "../../../../deployment/utils/RelayInitialConfig";
import { IProtocolMessageMerkleRoot, ProtocolMessageMerkleRoot } from "../../../../scripts/libs/protocol/ProtocolMessageMerkleRoot";
import { RelayMessage } from "../../../../scripts/libs/protocol/RelayMessage";
import {
  ISigningPolicy,
  SigningPolicy
} from "../../../../scripts/libs/protocol/SigningPolicy";
import { RelayInstance } from "../../../../typechain-truffle";
import { MerkleTree, verifyWithMerkleProof } from "../../../utils/MerkleTree";
import { getTestFile } from "../../../utils/constants";
import { toBN } from "../../../utils/test-helpers";
import { defaultTestSigningPolicy, generateSignatures, generateSignaturesEncoded } from "../coding/coding-helpers";
const coder = ethers.AbiCoder.defaultAbiCoder();

const Relay = artifacts.require("Relay");

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

interface FeeConfig {
  protocolId: number;
  feeInWei: string;
}

interface RelayGovernanceConfig {
  descriptionHash: string;
  chainId: number;
  newFeeConfigs: FeeConfig[];
}

const RelayGovernanceConfigABI = {
  "components": [
    {
      "internalType": "bytes32",
      "name": "descriptionHash",
      "type": "bytes32"
    },
    {
      "internalType": "uint256",
      "name": "chainId",
      "type": "uint256"
    },
    {
      "components": [
        {
          "internalType": "uint8",
          "name": "protocolId",
          "type": "uint8"
        },
        {
          "internalType": "uint256",
          "name": "feeInWei",
          "type": "uint256"
        }
      ],
      "internalType": "struct IRelay.FeeConfig[]",
      "name": "newFeeConfigs",
      "type": "tuple[]"
    }
  ],
  "internalType": "struct IRelay.RelayGovernanceConfig",
  "name": "_config",
  "type": "tuple"
}

function hashRelayGovernanceConfig(config: RelayGovernanceConfig): string {
  const abiEncoded = coder.encode([RelayGovernanceConfigABI as any], [config]);
  return ethers.keccak256(abiEncoded);
}

const relayGovernanceDescriptionHash = web3.utils.keccak256("RelayGovernance");

contract(`Relay.sol; ${getTestFile(__filename)}`, async () => {
  // let accounts: Account[];
  let signers: SignerWithAddress[];
  const accountPrivateKeys = (config.networks.hardhat.accounts as HardhatNetworkAccountConfig[]).map(x => x.privateKey);
  let relay: RelayInstance;
  const selector = ethers.keccak256(ethers.toUtf8Bytes("relay()"))!.slice(0, 10);
  const N = 100;
  const singleWeight = 500;
  // The next two should match the contract settings
  const firstVotingRoundStartSec = 1636070400;
  const votingRoundDurationSec = 90;
  const firstRewardEpochVotingRoundId = 1000;
  const rewardEpochDurationInVotingEpochs = 3360; // 3.5 days
  const votingRoundId = 4411;
  const rewardEpochId = Math.floor((votingRoundId - firstRewardEpochVotingRoundId) / rewardEpochDurationInVotingEpochs);
  let signingPolicyData: ISigningPolicy;
  const randomNumberProtocolId = 15;
  const THRESHOLD_INCREASE = 12000;
  const MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS = 3;
  let newSigningPolicyDataRelayed: ISigningPolicy;


  const firstVotingRoundInRewardEpoch = (rewardEpochId: number) => firstRewardEpochVotingRoundId + rewardEpochDurationInVotingEpochs * rewardEpochId;

  const prepareFullData = async (signingPolicyData: ISigningPolicy, newSigningPolicyData: ISigningPolicy) => {
    const localHash = SigningPolicy.hash(newSigningPolicyData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      localHash,
      N / 2 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      newSigningPolicy: newSigningPolicyData
    };
    return RelayMessage.encode(relayMessage);
  }

  before(async () => {
    // accounts = loadAccounts(web3);
    signers = (await ethers.getSigners()) as unknown as SignerWithAddress[];
    signingPolicyData = defaultTestSigningPolicy(
      signers.map(x => x.address),
      N,
      singleWeight
    );
    signingPolicyData.rewardEpochId = rewardEpochId;
    signingPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(rewardEpochId);
    const signingPolicy = SigningPolicy.encode(signingPolicyData);
    const localHash = SigningPolicy.hashEncoded(signingPolicy);

    const relayInitialConfig: RelayInitialConfig = {
      initialRewardEpochId: signingPolicyData.rewardEpochId,
      startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
      initialSigningPolicyHash: localHash,
      randomNumberProtocolId: randomNumberProtocolId,
      firstVotingRoundStartTs: firstVotingRoundStartSec,
      votingEpochDurationSeconds: votingRoundDurationSec,
      firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
      rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
      thresholdIncreaseBIPS: THRESHOLD_INCREASE,
      messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
      feeCollectionAddress: constants.ZERO_ADDRESS,
      feeConfigs: []
    }

    relay = await Relay.new(
      relayInitialConfig,
      constants.ZERO_ADDRESS
    );
  });

  let merkleRoot: string;
  let messageData: IProtocolMessageMerkleRoot;

  beforeEach(async () => {
    merkleRoot = ethers.hexlify(ethers.randomBytes(32));
    messageData = {
      protocolId: randomNumberProtocolId,
      votingRoundId,
      isSecureRandom: true,
      merkleRoot,
    } as IProtocolMessageMerkleRoot;
  });

  it("Should initial signing policy be initialized", async () => {
    const signingPolicy = SigningPolicy.encode(signingPolicyData);
    const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay.lastInitializedRewardEpochData();
    expect(_lastInitializedRewardEpoch.toString()).to.equal(signingPolicyData.rewardEpochId.toString());
    expect(_startingVotingRoundIdForLastInitializedRewardEpoch.toString()).to.equal(signingPolicyData.startVotingRoundId.toString());
  });

  it("Should relay a message for random number generating protocol", async () => {
    const messageHash = ProtocolMessageMerkleRoot.hash(messageData);
    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      N / 2 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: messageData,
    };

    const fullData = RelayMessage.encode(relayMessage);
    const receipt = await web3.eth.sendTransaction({
      from: signers[0].address,
      to: relay.address,
      data: selector + fullData.slice(2),
    })
    await expectEvent.inTransaction(receipt!.transactionHash, relay, "ProtocolMessageRelayed", {
      protocolId: toBN(messageData.protocolId),
      votingRoundId: toBN(messageData.votingRoundId),
      isSecureRandom: messageData.isSecureRandom,
      merkleRoot: merkleRoot,
    });
    console.log("Gas used:", receipt?.gasUsed?.toString());
    expect(await relay.isFinalized(messageData.protocolId, messageData.votingRoundId)).to.equal(true);

    let stateData = await relay.stateData();
    expect(stateData.randomNumberProtocolId.toString()).to.be.equal(messageData.protocolId.toString());
    expect(stateData.randomVotingRoundId.toString()).to.be.equal(messageData.votingRoundId.toString());
    expect(stateData.isSecureRandom.toString()).to.be.equal(messageData.isSecureRandom.toString());

    expect(RelayMessage.decode(fullData)).not.to.throw;
    const decodedRelayMessage = RelayMessage.decode(fullData);

    expect(RelayMessage.equals(relayMessage, decodedRelayMessage)).to.be.true;
    const { _randomNumber, _isSecureRandom, _randomTimestamp } = await relay.getRandomNumber();
    expect(_isSecureRandom).to.be.true;
    expect(_randomNumber.toString()).to.equal(BigInt(web3.utils.keccak256(messageData.merkleRoot)).toString());
    expect(_randomTimestamp.toNumber()).to.equal(firstVotingRoundStartSec + votingRoundDurationSec * (messageData.votingRoundId + 1));
    expect((await relay.getVotingRoundId(_randomTimestamp)).toNumber()).to.be.equal(toBN(messageData.votingRoundId + 1));
  });

  it("Should relay a message for non random number generating protocol", async () => {
    messageData.protocolId++;
    messageData.isSecureRandom = false;
    const messageHash = ProtocolMessageMerkleRoot.hash(messageData);
    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      N / 2 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: messageData,
    };

    const fullData = RelayMessage.encode(relayMessage);
    const receipt = await web3.eth.sendTransaction({
      from: signers[0].address,
      to: relay.address,
      data: selector + fullData.slice(2),
    })
    await expectEvent.inTransaction(receipt!.transactionHash, relay, "ProtocolMessageRelayed", {
      protocolId: toBN(messageData.protocolId),
      votingRoundId: toBN(messageData.votingRoundId),
      isSecureRandom: messageData.isSecureRandom,
      merkleRoot: merkleRoot,
    });
    console.log("Gas used:", receipt?.gasUsed?.toString());
    expect(await relay.isFinalized(messageData.protocolId, messageData.votingRoundId)).to.equal(true);

    let stateData = await relay.stateData();
    expect(stateData.randomNumberProtocolId.toString()).to.be.equal(randomNumberProtocolId.toString());
    // because of the previous test
    expect(stateData.randomVotingRoundId.toString()).to.be.equal(messageData.votingRoundId.toString());
    // expect(stateData.isSecureRandom.toString()).to.be.equal(messageData.isSecureRandom.toString());

    expect(RelayMessage.decode(fullData)).not.to.throw;
    const decodedRelayMessage = RelayMessage.decode(fullData);

    expect(RelayMessage.equals(relayMessage, decodedRelayMessage)).to.be.true;
    const { _randomNumber, _isSecureRandom, _randomTimestamp } = await relay.getRandomNumber();
    // Because of previous test
    expect(_isSecureRandom).to.be.true;
    // different randomly generated merkle root
    expect(_randomNumber.toString()).to.not.equal(BigInt(web3.utils.keccak256(messageData.merkleRoot)).toString());
    expect(_randomTimestamp.toNumber()).to.equal(firstVotingRoundStartSec + votingRoundDurationSec * (messageData.votingRoundId + 1));
    expect((await relay.getVotingRoundId(_randomTimestamp)).toNumber()).to.be.equal(toBN(messageData.votingRoundId + 1));
  });
 
  it("Should fail to relay a message due to low weight", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId++;

    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      N / 2
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Not enough weight");
  });

  it("Should fail to relay a message due to non increasing signature indices", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId++;
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      0,
      [0, 1, 2, 2, 1]
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);


    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Index out of order");
  });

  it("Should fail to relay a message due signature indices out of range", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId++;

    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      0,
      [0, 1, 2, 101]
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Index out of range");
  });

  it("Should fail to relay a message due too short data for metadata", async () => {
    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + "0000",
      })
    ).to.be.revertedWith("Invalid sign policy metadata");
  });

  it("Should fail to relay a message on mismatch of signing policy length", async () => {
    const signingPolicy = SigningPolicy.encode(signingPolicyData).slice(2);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy.slice(0, -2),
      })
    ).to.be.revertedWith("Invalid sign policy length");
  });

  it("Should fail due to signing policy hash mismatch", async () => {
    const signingPolicy = SigningPolicy.encode(signingPolicyData).slice(2);
    const tweakedSigningPolicy = signingPolicy.slice(0, -2) + ((parseInt(signingPolicy.slice(-2), 16) + 1) % 256).toString(16).padStart(2, "0");

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + tweakedSigningPolicy + "00",
      })
    ).to.be.revertedWith("Signing policy hash mismatch");
  });

  it("Should fail to relay a message due to too short message", async () => {
    const signingPolicy = SigningPolicy.encode(signingPolicyData).slice(2);
    const fullMessage = ProtocolMessageMerkleRoot.encode(messageData).slice(2);
    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy + fullMessage.slice(0, -2),
      })
    ).to.be.revertedWith("Too short message");
  });

  it("Should fail to relay message due to delayed signing policy", async () => {
    // "Delayed sign policy"
    const newSigningPolicyData = { ...signingPolicyData };
    newSigningPolicyData.startVotingRoundId = votingRoundId + 1;
    const signingPolicy = SigningPolicy.encode(newSigningPolicyData);

    const relayInitialConfig: RelayInitialConfig = {
      initialRewardEpochId: newSigningPolicyData.rewardEpochId,
      startingVotingRoundIdForInitialRewardEpochId: newSigningPolicyData.startVotingRoundId,
      initialSigningPolicyHash: SigningPolicy.hashEncoded(signingPolicy),
      randomNumberProtocolId: randomNumberProtocolId,
      firstVotingRoundStartTs: firstVotingRoundStartSec,
      votingEpochDurationSeconds: votingRoundDurationSec,
      firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
      rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
      thresholdIncreaseBIPS: THRESHOLD_INCREASE,
      messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
      feeCollectionAddress: constants.ZERO_ADDRESS,
      feeConfigs: []
    }

    const relay2 = await Relay.new(
      relayInitialConfig,
      constants.ZERO_ADDRESS
    );

    const fullMessage = ProtocolMessageMerkleRoot.encode(messageData).slice(2);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay2.address,
        data: selector + signingPolicy.slice(2) + fullMessage
      })
    ).to.be.revertedWith("Delayed sign policy");

  });

  it("Should fail to relay a message due to wrong signing policy reward epoch id", async () => {
    const newMessageData = { ...messageData };
    // newMessageData.votingRoundId = votingRoundId - rewardEpochDurationInVotingEpochs; // shift to previous reward epoch
    newMessageData.votingRoundId = 1; // shift to previous reward epoch
    let fullMessage = ProtocolMessageMerkleRoot.encode(newMessageData).slice(2);
    const signingPolicy = SigningPolicy.encode(signingPolicyData).slice(2);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy + fullMessage
      })
    ).to.be.revertedWith("Invalid voting round id");

    newMessageData.votingRoundId = votingRoundId - rewardEpochDurationInVotingEpochs; // shift to one epoch after next reward epoch
    fullMessage = ProtocolMessageMerkleRoot.encode(newMessageData).slice(2);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy + fullMessage
      })
    ).to.be.revertedWith("Wrong sign policy reward epoch");


    newMessageData.votingRoundId = votingRoundId + 2 * rewardEpochDurationInVotingEpochs; // shift to one epoch after next reward epoch
    fullMessage = ProtocolMessageMerkleRoot.encode(newMessageData).slice(2);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy + fullMessage + "0000"
      })
    ).to.be.revertedWith("Not enough weight");

    newMessageData.votingRoundId = votingRoundId + rewardEpochDurationInVotingEpochs; // shift to next reward epoch
    fullMessage = ProtocolMessageMerkleRoot.encode(newMessageData).slice(2);

    // should be able to use previous reward epoch signing policy, but since no signatures count is provided, should fail
    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy + fullMessage
      })
    ).to.be.revertedWith("No signature count");

    // should be able to use previous reward epoch signing policy, but since 0 are provided, it should fail
    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + signingPolicy + fullMessage + "0000"
      })
    ).to.be.revertedWith("Not enough weight");
  });

  it("Should relay a message with old signing policy and 20% signatures more", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId = votingRoundId + rewardEpochDurationInVotingEpochs; // shift to next reward epoch
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatureObjects = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      Math.round(N * 0.6) + 1
    );

    let relayMessage = {
      signingPolicy: signingPolicyData,
      signatures: signatureObjects,
      protocolMessageMerkleRoot: newMessageData,
    };
    const fullData = RelayMessage.encode(relayMessage);

    const receipt = await web3.eth.sendTransaction({
      from: signers[0].address,
      to: relay.address,
      data: selector + fullData.slice(2),
    })
    await expectEvent.inTransaction(receipt!.transactionHash, relay, "ProtocolMessageRelayed", {
      protocolId: toBN(newMessageData.protocolId),
      votingRoundId: toBN(newMessageData.votingRoundId),
      isSecureRandom: newMessageData.isSecureRandom,
      merkleRoot: merkleRoot,
    });
    console.log("Gas used:", receipt?.gasUsed?.toString());
    expect(await relay.isFinalized(newMessageData.protocolId, newMessageData.votingRoundId)).to.equal(true);

    let stateData = await relay.stateData();
    expect(stateData.randomNumberProtocolId.toString()).to.be.equal(newMessageData.protocolId.toString());
    expect(stateData.randomVotingRoundId.toString()).to.be.equal(newMessageData.votingRoundId.toString());
    expect(stateData.isSecureRandom.toString()).to.be.equal(newMessageData.isSecureRandom.toString());
  });

  it("Should fail to relay a message with old signing policy and less then 20%+ more weight", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId = firstVotingRoundInRewardEpoch(signingPolicyData.rewardEpochId + 1) + 5;//votingRoundId + rewardEpochDurationInVotingEpochs + 1; // shift to next reward epoch
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      Math.round(N * 0.6)
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Not enough weight");
  });

  it("Should relay a new signing policy", async () => {
    newSigningPolicyDataRelayed = { ...signingPolicyData };
    const newRewardEpoch = newSigningPolicyDataRelayed.rewardEpochId + 1;
    newSigningPolicyDataRelayed.rewardEpochId = newRewardEpoch;
    newSigningPolicyDataRelayed.voters = newSigningPolicyDataRelayed.voters.slice(0, 50);
    newSigningPolicyDataRelayed.weights = newSigningPolicyDataRelayed.weights.slice(0, 50);
    newSigningPolicyDataRelayed.threshold = Math.round(newSigningPolicyDataRelayed.threshold / 2);
    newSigningPolicyDataRelayed.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch) + 10;  // create a delay

    const localHash = SigningPolicy.hash(newSigningPolicyDataRelayed);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      localHash,
      N / 2 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      newSigningPolicy: newSigningPolicyDataRelayed
    };

    const fullData = RelayMessage.encode(relayMessage);

    const receipt = await web3.eth.sendTransaction({
      from: signers[0].address,
      to: relay.address,
      data: selector + fullData.slice(2),
    })
    await expectEvent.inTransaction(receipt!.transactionHash, relay, "SigningPolicyRelayed", {
      rewardEpochId: toBN(newSigningPolicyDataRelayed.rewardEpochId),
    });
    const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay.lastInitializedRewardEpochData();
    expect(_lastInitializedRewardEpoch.toString()).to.equal(newRewardEpoch.toString());
    expect(_startingVotingRoundIdForLastInitializedRewardEpoch.toString()).to.equal(newSigningPolicyDataRelayed.startVotingRoundId.toString());
    console.log("Gas used:", receipt?.gasUsed?.toString());
  });

  it("Should relay several signing policies and fail relaying a too old message", async () => {
    const signingPolicy = SigningPolicy.encode(signingPolicyData);
    const localHash0 = SigningPolicy.hashEncoded(signingPolicy);

    const relayInitialConfig: RelayInitialConfig = {
      initialRewardEpochId: signingPolicyData.rewardEpochId,
      startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
      initialSigningPolicyHash: localHash0,
      randomNumberProtocolId: randomNumberProtocolId,
      firstVotingRoundStartTs: firstVotingRoundStartSec,
      votingEpochDurationSeconds: votingRoundDurationSec,
      firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
      rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
      thresholdIncreaseBIPS: THRESHOLD_INCREASE,
      messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
      feeCollectionAddress: constants.ZERO_ADDRESS,
      feeConfigs: []
    }

    const relay2 = await Relay.new(
      relayInitialConfig,
      constants.ZERO_ADDRESS
    );

    let lastSigningPolicyData = signingPolicyData;
    for (let i = signingPolicyData.rewardEpochId + 1; i < signingPolicyData.rewardEpochId + MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS + 2; i++) {
      const newSigningPolicyDataRelayed = { ...signingPolicyData };
      const newRewardEpoch = i;
      newSigningPolicyDataRelayed.rewardEpochId = newRewardEpoch;
      newSigningPolicyDataRelayed.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);

      const localHash = SigningPolicy.hash(newSigningPolicyDataRelayed);

      const signatures = await generateSignatures(
        accountPrivateKeys,
        localHash,
        N / 2 + 1
      );

      const relayMessage = {
        signingPolicy: lastSigningPolicyData,
        signatures,
        newSigningPolicy: newSigningPolicyDataRelayed
      };

      const fullData = RelayMessage.encode(relayMessage);

      // const hashBefore = await relay.toSigningPolicyHash(newRewardEpoch, {from: signers[10].address});
      // expect(hashBefore).to.equal(ZERO_BYTES32);

      const receipt = await web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay2.address,
        data: selector + fullData.slice(2),
      })
      await expectEvent.inTransaction(receipt!.transactionHash, relay2, "SigningPolicyRelayed", {
        rewardEpochId: toBN(newSigningPolicyDataRelayed.rewardEpochId),
      });
      const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay2.lastInitializedRewardEpochData();
      expect(_lastInitializedRewardEpoch.toString()).to.equal(newRewardEpoch.toString());
      expect(_startingVotingRoundIdForLastInitializedRewardEpoch.toString()).to.equal(newSigningPolicyDataRelayed.startVotingRoundId.toString());
      lastSigningPolicyData = newSigningPolicyDataRelayed;
    }

    const newMessageData = { ...messageData };
    newMessageData.votingRoundId++;
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);
    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      N / 2 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay2.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Message too old");

  });


  it("Should fail to relay an already relayed message by old signing policy with a new signing policy", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId = votingRoundId + rewardEpochDurationInVotingEpochs; // shift to next reward epoch
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const newSigningPolicyData = { ...signingPolicyData };
    const newRewardEpoch = newSigningPolicyData.rewardEpochId + 1;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    newSigningPolicyData.threshold = Math.round(newSigningPolicyData.threshold / 2);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch) + 10;

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      26
    );

    const relayMessage = {
      signingPolicy: newSigningPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Already relayed");
  });

  it("Should relay a message with new signing policy", async () => {
    const newSigningPolicyData = { ...signingPolicyData };
    const newRewardEpoch = newSigningPolicyData.rewardEpochId + 1;

    const newMessageData = { ...messageData };
    // newMessageData.votingRoundId = votingRoundId + rewardEpochDurationInVotingEpochs - 1; // shift to next reward epoch
    newMessageData.votingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch) + 12;
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch) + 10;
    newSigningPolicyData.threshold = Math.round(newSigningPolicyData.threshold / 2);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      26
    );

    const relayMessage = {
      signingPolicy: newSigningPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    const receipt = await web3.eth.sendTransaction({
      from: signers[0].address,
      to: relay.address,
      data: selector + fullData.slice(2),
    })
    await expectEvent.inTransaction(receipt!.transactionHash, relay, "ProtocolMessageRelayed", {
      protocolId: toBN(newMessageData.protocolId),
      votingRoundId: toBN(newMessageData.votingRoundId),
      isSecureRandom: newMessageData.isSecureRandom,
      merkleRoot: merkleRoot,
    });
    console.log("Gas used:", receipt?.gasUsed?.toString());
    expect(await relay.isFinalized(newMessageData.protocolId, newMessageData.votingRoundId)).to.equal(true);

    let stateData = await relay.stateData();
    expect(stateData.randomNumberProtocolId.toString()).to.be.equal(newMessageData.protocolId.toString());
    expect(stateData.randomVotingRoundId.toString()).to.be.equal(newMessageData.votingRoundId.toString());
    expect(stateData.isSecureRandom.toString()).to.be.equal(newMessageData.isSecureRandom.toString());

  });

  it("Should relay a message with old signing policy and less then 20%+ more weight after delayed reward epoch initialization", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId = firstVotingRoundInRewardEpoch(signingPolicyData.rewardEpochId + 1) + 9; // new startingVotingRoundId is on +10
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      Math.round(N * 0.6)
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    const receipt = await web3.eth.sendTransaction({
      from: signers[0].address,
      to: relay.address,
      data: selector + fullData.slice(2),
    })
    await expectEvent.inTransaction(receipt!.transactionHash, relay, "ProtocolMessageRelayed", {
      protocolId: toBN(newMessageData.protocolId),
      votingRoundId: toBN(newMessageData.votingRoundId),
      isSecureRandom: newMessageData.isSecureRandom,
      merkleRoot: merkleRoot,
    });
    console.log("Gas used:", receipt?.gasUsed?.toString());
    expect(await relay.isFinalized(newMessageData.protocolId, newMessageData.votingRoundId)).to.equal(true);

    let stateData = await relay.stateData();
    expect(stateData.randomNumberProtocolId.toString()).to.be.equal(newMessageData.protocolId.toString());
    expect(stateData.randomVotingRoundId.toString()).to.be.equal(newMessageData.votingRoundId.toString());
    expect(stateData.isSecureRandom.toString()).to.be.equal(newMessageData.isSecureRandom.toString());
  });

  it("Should fail to relay a message with old signing policy when a new was initialized and votingRoundId is over startingVotingRoundId", async () => {
    const newMessageData = { ...messageData };
    newMessageData.votingRoundId = firstVotingRoundInRewardEpoch(signingPolicyData.rewardEpochId + 1) + 10; // new startingVotingRoundId is on +10
    const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      Math.round(N * 0.6)
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: newMessageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Must use new sign policy");
  });


  it("Should fail to relay a new signing policy due to not provided new sign policy size", async () => {
    // "No new sign policy size"

    const newSigningPolicyData = { ...signingPolicyData };
    const newRewardEpoch = newSigningPolicyData.rewardEpochId + 1;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);

    const signingPolicy = SigningPolicy.encode(signingPolicyData).slice(2);
    const fullData = signingPolicy + "00";

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData,
      })
    ).to.be.revertedWith("No new sign policy size");
  });

  it("Should fail to relay a new signing policy due to wrong size of new signing policy", async () => {
    // "Wrong size for new sign policy"
    const newSigningPolicyData = { ...signingPolicyData };
    const newRewardEpoch = newSigningPolicyData.rewardEpochId + 1;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);

    let newSigningPolicy = SigningPolicy.encode(newSigningPolicyData).slice(2);
    const signingPolicy = SigningPolicy.encode(signingPolicyData).slice(2);
    newSigningPolicy = (parseInt(newSigningPolicy.slice(0, 4), 16) + 1).toString(16).padStart(4, "0") + newSigningPolicy.slice(4);
    const fullData = signingPolicy + "00" + newSigningPolicy;

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData,
      })
    ).to.be.revertedWith("Wrong size for new sign policy");

  });

  it("Should fail to relay a new signing policy due to not providing last initialized signing policy for relaying new signing policy", async () => {
    // "Not next reward epoch"
    const newSigningPolicyData = { ...signingPolicyData };
    const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay.lastInitializedRewardEpochData()
    const newRewardEpoch = parseInt(_lastInitializedRewardEpoch.toString()) + 2;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);
    const localHash = SigningPolicy.hash(newSigningPolicyData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      localHash,
      N / 4 + 1
    );

    const relayMessage = {
      signingPolicy: newSigningPolicyDataRelayed,
      signatures,
      newSigningPolicy: newSigningPolicyData
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Not next reward epoch");
  });

  it("Should fail to relay a new signing policy due to provided new signing policy for a wrong reward epoch", async () => {
    // "Not next reward epoch"
    const newSigningPolicyData = { ...signingPolicyData };
    const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay.lastInitializedRewardEpochData()
    const newRewardEpoch = parseInt(_lastInitializedRewardEpoch.toString()) + 1;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);
    const localHash = SigningPolicy.hash(newSigningPolicyData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      localHash,
      N / 4 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      newSigningPolicy: newSigningPolicyData
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Not with last intialized");
  });

  it("Should fail to relay a new signing policy due to wrong length of signature data", async () => {
    // "Not enough signatures"
    const newSigningPolicyData = { ...signingPolicyData };
    const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay.lastInitializedRewardEpochData();
    const newRewardEpoch = parseInt(_lastInitializedRewardEpoch.toString()) + 1;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    const weightSum = newSigningPolicyData.weights.reduce((a, b) => a + b, 0);
    newSigningPolicyData.threshold = Math.ceil(weightSum / 2);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);
    const localHash = SigningPolicy.hash(newSigningPolicyData);
    const signatures = await generateSignaturesEncoded(
      accountPrivateKeys,
      localHash,
      N / 4 + 1
    );
    const newSigningPolicy = SigningPolicy.encode(newSigningPolicyData).slice(2);
    const signingPolicy = SigningPolicy.encode(newSigningPolicyDataRelayed).slice(2);
    const fullData = signingPolicy + "00" + newSigningPolicy + signatures.slice(0, -2);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData,
      })
    ).to.be.revertedWith("Not enough signatures");
  });

  it("Should fail to relay a new signing policy due to a wrong signature", async () => {
    // "Wrong signature"
    const newSigningPolicyData = { ...signingPolicyData };
    const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay.lastInitializedRewardEpochData();
    const newRewardEpoch = parseInt(_lastInitializedRewardEpoch.toString()) + 1;
    newSigningPolicyData.rewardEpochId = newRewardEpoch;
    newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
    newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
    const weightSum = newSigningPolicyData.weights.reduce((a, b) => a + b, 0);
    newSigningPolicyData.threshold = Math.ceil(weightSum / 2);
    newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);
    const localHash = SigningPolicy.hash(newSigningPolicyData);
    const signatures = await generateSignaturesEncoded(
      accountPrivateKeys,
      localHash,
      N / 4 + 1
    );
    const newSigningPolicy = SigningPolicy.encode(newSigningPolicyData).slice(2);
    const signingPolicy = SigningPolicy.encode(newSigningPolicyDataRelayed).slice(2);
    const tweakedSignatures = signatures.slice(0, -6) + ((parseInt(signatures.slice(-6, -4), 16) + 1) % 256).toString(16).padStart(2, "0") + signatures.slice(-4);
    const fullData = signingPolicy + "00" + newSigningPolicy + tweakedSignatures;
    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData,
      })
    ).to.be.revertedWith("Wrong signature");
  });
  it("Should fail to relay a message due to message already relayed", async () => {
    // "Already relayed"

    const messageHash = ProtocolMessageMerkleRoot.hash(messageData);

    const signatures = await generateSignatures(
      accountPrivateKeys,
      messageHash,
      N / 2 + 1
    );

    const relayMessage = {
      signingPolicy: signingPolicyData,
      signatures,
      protocolMessageMerkleRoot: messageData,
    };

    const fullData = RelayMessage.encode(relayMessage);

    await expect(
      signers[0].sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
    ).to.be.revertedWith("Already relayed");
  });

  describe("Direct signing policy setup", async () => {
    it("Should directly set the signing policy", async () => {
      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig,
        signers[0].address
      );

      const newSigningPolicyData = { ...signingPolicyData };
      newSigningPolicyData.rewardEpochId += 1;
      newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newSigningPolicyData.rewardEpochId);

      expectEvent(await relay2.setSigningPolicy(newSigningPolicyData), "SigningPolicyInitialized",
        {
          rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
          startVotingRoundId: toBN(newSigningPolicyData.startVotingRoundId),
          voters: newSigningPolicyData.voters,
          seed: toBN(newSigningPolicyData.seed),
          threshold: toBN(newSigningPolicyData.threshold),
          weights: newSigningPolicyData.weights.map(x => toBN(x)),
          signingPolicyBytes: SigningPolicy.encode(newSigningPolicyData)
        });


      // console.dir(receipt);
      const { _lastInitializedRewardEpoch, _startingVotingRoundIdForLastInitializedRewardEpoch } = await relay2.lastInitializedRewardEpochData();
      expect(_lastInitializedRewardEpoch.toString()).to.equal(newSigningPolicyData.rewardEpochId.toString());
      expect(_startingVotingRoundIdForLastInitializedRewardEpoch.toString()).to.equal(newSigningPolicyData.startVotingRoundId.toString());

    });

    it("Should fail to directly set the signing policy due to wrong reward epoch", async () => {
      // "not next reward epoch"
      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig,
        signers[0].address
      );

      const newSigningPolicyData = { ...signingPolicyData };

      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "not next reward epoch");
      newSigningPolicyData.rewardEpochId += 2;
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "not next reward epoch");

    });

    it("Should fail to directly set or relay the signing policy due to policy being trivial", async () => {
      // "must be non-trivial"

      const relayInitialConfig2: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig2,
        signers[0].address
      );

      const relayInitialConfig3: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay3 = await Relay.new(
        relayInitialConfig3,
        constants.ZERO_ADDRESS
      );

      const newSigningPolicyData = { ...signingPolicyData };
      newSigningPolicyData.rewardEpochId += 1;
      newSigningPolicyData.voters = [];
      newSigningPolicyData.weights = [];
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "must be non-trivial");
      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay3.address,
          data: selector + (await prepareFullData(signingPolicyData, newSigningPolicyData)).slice(2),
        })
      ).to.be.revertedWith("must be non-trivial");
    });

    it("Should fail due to voters and weights length mismatch", async () => {
      // "size mismatch"
      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig,
        signers[0].address
      );

      const newSigningPolicyData = { ...signingPolicyData };
      newSigningPolicyData.rewardEpochId += 1;
      newSigningPolicyData.weights = [];
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "size mismatch");

    });

    it("Should fail due to wrong setter", async () => {
      // "only sign policy setter"
      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig,
        signers[0].address
      );

      const newSigningPolicyData = { ...signingPolicyData };
      newSigningPolicyData.rewardEpochId += 1;
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData, { from: signers[1].address }), "only sign policy setter");
    });

    it("Should fail to directly set the signing policy due to sum of weight being below threshold", async () => {
      // "not next reward epoch"
      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig,
        signers[0].address
      );

      const newSigningPolicyData = { ...signingPolicyData, rewardEpochId: signingPolicyData.rewardEpochId + 1, weights: [...signingPolicyData.weights] };
      let totalWeight = 0;
      for (let i = 0; i < newSigningPolicyData.weights.length; i++) {
        newSigningPolicyData.weights[i] = Math.floor(newSigningPolicyData.weights[i] / 3);
        totalWeight += newSigningPolicyData.weights[i];
      }
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "too big threshold");
      const dif = newSigningPolicyData.threshold - totalWeight;
      newSigningPolicyData.weights[0] += dif;
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "too big threshold");
      // newSigningPolicyData.weights[0] += 1;
      // expectEvent(await relay2.setSigningPolicy(newSigningPolicyData), "SigningPolicyInitialized",
      //   {
      //     rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
      //     startVotingRoundId: toBN(newSigningPolicyData.startVotingRoundId),
      //     voters: newSigningPolicyData.voters,
      //     seed: toBN(newSigningPolicyData.seed),
      //     threshold: toBN(newSigningPolicyData.threshold),
      //     weights: newSigningPolicyData.weights.map(x => toBN(x)),
      //     signingPolicyBytes: SigningPolicy.encode(newSigningPolicyData)
      //   });
    });

    it("Should fail to relay new signing policy due to policy setter being set", async () => {
      const signingPolicy = SigningPolicy.encode(signingPolicyData);
      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hashEncoded(signingPolicy),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig,
        signers[0].address
      );

      const newSigningPolicyData = { ...signingPolicyData };
      const newRewardEpoch = newSigningPolicyData.rewardEpochId + 1;
      newSigningPolicyData.rewardEpochId = newRewardEpoch;
      newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 50);
      newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 50);
      newSigningPolicyData.threshold = Math.round(newSigningPolicyData.threshold / 2);
      newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch) + 10;  // create a delay
      const localHash = SigningPolicy.hash(newSigningPolicyData);

      const signatures = await generateSignatures(
        accountPrivateKeys,
        localHash,
        N / 2 + 1
      );

      const relayMessage = {
        signingPolicy: signingPolicyData,
        signatures,
        newSigningPolicy: newSigningPolicyData,
      };

      const fullData = RelayMessage.encode(relayMessage);

      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay2.address,
          data: selector + fullData.slice(2),
        })
      ).to.be.revertedWith("Sign policy relay disabled");
    });

    it("Should fail directly setup voters with wrong number of voters", async () => {
      const newSigningPolicyData = defaultTestSigningPolicy(
        signers.map(x => x.address),
        301, // max is 300
        200
      );
      newSigningPolicyData.rewardEpochId = signingPolicyData.rewardEpochId + 1;

      const relayInitialConfig2: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig2,
        signers[0].address
      );

      const relayInitialConfig3: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay3 = await Relay.new(
        relayInitialConfig3,
        constants.ZERO_ADDRESS
      );

      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "too many voters");
      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay3.address,
          data: selector + (await prepareFullData(signingPolicyData, newSigningPolicyData)).slice(2),
        })
      ).to.be.revertedWith("too many voters");

      newSigningPolicyData.voters = newSigningPolicyData.voters.slice(0, 300);
      newSigningPolicyData.weights = newSigningPolicyData.weights.slice(0, 300);
      expectEvent(await relay2.setSigningPolicy(newSigningPolicyData), "SigningPolicyInitialized",
        {
          rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
          startVotingRoundId: toBN(newSigningPolicyData.startVotingRoundId),
          voters: newSigningPolicyData.voters,
          seed: toBN(newSigningPolicyData.seed),
          threshold: toBN(newSigningPolicyData.threshold),
          weights: newSigningPolicyData.weights.map(x => toBN(x)),
          signingPolicyBytes: SigningPolicy.encode(newSigningPolicyData)
        });

    });

    it("Should fail due to total weight be too big or not in sync with threshold limits", async () => {
      const newSigningPolicyData = { ...signingPolicyData, weights: [...signingPolicyData.weights] };
      const newRewardEpoch = newSigningPolicyData.rewardEpochId + 1;
      newSigningPolicyData.rewardEpochId = newRewardEpoch;
      newSigningPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(newRewardEpoch);

      let totalWeight = 0;
      for (const weight of newSigningPolicyData.weights) {
        totalWeight += weight;
      }

      const relayInitialConfig2: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay2 = await Relay.new(
        relayInitialConfig2,
        signers[0].address
      );

      const relayInitialConfig3: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: SigningPolicy.hash(signingPolicyData),
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay3 = await Relay.new(
        relayInitialConfig3,
        constants.ZERO_ADDRESS
      );

      newSigningPolicyData.weights[0] = 2 ** 16 - 1;
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "total weight too big");
      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay3.address,
          data: selector + (await prepareFullData(signingPolicyData, newSigningPolicyData)).slice(2),
        })
      ).to.be.revertedWith("total weight too big");

      newSigningPolicyData.weights[0] = newSigningPolicyData.weights[1] + 1;
      newSigningPolicyData.threshold = Math.floor(totalWeight / 2);
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "too small threshold");
      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay3.address,
          data: selector + (await prepareFullData(signingPolicyData, newSigningPolicyData)).slice(2),
        })
      ).to.be.revertedWith("too small threshold");

      newSigningPolicyData.weights[0] = newSigningPolicyData.weights[1];
      newSigningPolicyData.threshold = Math.floor(totalWeight / 2) - 1;
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "too small threshold");
      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay3.address,
          data: selector + (await prepareFullData(signingPolicyData, newSigningPolicyData)).slice(2),
        })
      ).to.be.revertedWith("too small threshold");


      expect(totalWeight).to.equal(50000);  // further tests are designed assuming 50000!
      newSigningPolicyData.threshold = Math.floor(totalWeight / 2);
      expectEvent(await relay2.setSigningPolicy(newSigningPolicyData), "SigningPolicyInitialized",
        {
          rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
          startVotingRoundId: toBN(newSigningPolicyData.startVotingRoundId),
          voters: newSigningPolicyData.voters,
          seed: toBN(newSigningPolicyData.seed),
          threshold: toBN(newSigningPolicyData.threshold),
          weights: newSigningPolicyData.weights.map(x => toBN(x)),
          signingPolicyBytes: SigningPolicy.encode(newSigningPolicyData)
        });

      let receipt = await web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay3.address,
        data: selector + (await prepareFullData(signingPolicyData, newSigningPolicyData)).slice(2),
      })

      await expectEvent.inTransaction(receipt!.transactionHash, relay3, "SigningPolicyRelayed", {
        rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
      });

      let lastRelayedSigningPolicy = { ...newSigningPolicyData };

      newSigningPolicyData.rewardEpochId += 1;
      newSigningPolicyData.threshold = Math.floor(totalWeight * 0.66) + 1;
      await expectRevert(relay2.setSigningPolicy(newSigningPolicyData), "too big threshold");
      await expect(
        signers[0].sendTransaction({
          from: signers[0].address,
          to: relay3.address,
          data: selector + (await prepareFullData(lastRelayedSigningPolicy, newSigningPolicyData)).slice(2),
        })
      ).to.be.revertedWith("too big threshold");


      newSigningPolicyData.threshold = Math.floor(totalWeight * 0.66);
      expectEvent(await relay2.setSigningPolicy(newSigningPolicyData), "SigningPolicyInitialized",
        {
          rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
          startVotingRoundId: toBN(newSigningPolicyData.startVotingRoundId),
          voters: newSigningPolicyData.voters,
          seed: toBN(newSigningPolicyData.seed),
          threshold: toBN(newSigningPolicyData.threshold),
          weights: newSigningPolicyData.weights.map(x => toBN(x)),
          signingPolicyBytes: SigningPolicy.encode(newSigningPolicyData)
        });

      receipt = await web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay3.address,
        data: selector + (await prepareFullData(lastRelayedSigningPolicy, newSigningPolicyData)).slice(2),
      })

      await expectEvent.inTransaction(receipt!.transactionHash, relay3, "SigningPolicyRelayed", {
        rewardEpochId: toBN(newSigningPolicyData.rewardEpochId),
      });

    });

  });

  describe("Verification", async () => {
    it("Should verification work", async () => {
      const signingPolicyData = defaultTestSigningPolicy(
        signers.map(x => x.address),
        N,
        singleWeight
      );
      signingPolicyData.rewardEpochId = rewardEpochId;
      signingPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(rewardEpochId);
      const signingPolicy = SigningPolicy.encode(signingPolicyData);
      const localHash = SigningPolicy.hashEncoded(signingPolicy);

      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: localHash,
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: BURN_ADDRESS,
        feeConfigs: [{
          protocolId: 17,
          feeInWei: "1000"
        }]
      }

      const relay = await Relay.new(
        relayInitialConfig,
        constants.ZERO_ADDRESS
      );

      const makeHashes = (i: number, shiftSeed = 0) =>
        new Array(i).fill(0).map((x, i) => ethers.keccak256(ethers.toBeHex(shiftSeed + i)));
      const hashes = makeHashes(100);
      const tree = new MerkleTree(hashes);
      const specificHash = hashes[10];

      const proof = tree.getProof(specificHash);
      const newMessageData = { ...messageData };
      newMessageData.merkleRoot = tree.root!;
      const specificVotingRoundId = newMessageData.votingRoundId + 5;
      newMessageData.votingRoundId = specificVotingRoundId;
      let messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);
      let signatures = await generateSignatures(
        accountPrivateKeys,
        messageHash,
        N / 2 + 1
      );

      let relayMessage = {
        signingPolicy: signingPolicyData,
        signatures,
        protocolMessageMerkleRoot: newMessageData,
      };

      let fullData = RelayMessage.encode(relayMessage);
      let receipt = await web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
      expect(verifyWithMerkleProof(specificHash, proof!, tree.root!)).to.be.true;
      const oldBalance = Number(await web3.eth.getBalance(BURN_ADDRESS));
      await relay.verify(newMessageData.protocolId, newMessageData.votingRoundId, specificHash, proof);

      newMessageData.protocolId = 17;

      messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);
      signatures = await generateSignatures(
        accountPrivateKeys,
        messageHash,
        N / 2 + 1
      );

      relayMessage = {
        signingPolicy: signingPolicyData,
        signatures,
        protocolMessageMerkleRoot: newMessageData,
      };

      fullData = RelayMessage.encode(relayMessage);

      receipt = await web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })

      await expectRevert(relay.verify(newMessageData.protocolId, newMessageData.votingRoundId, specificHash, proof), "too low fee");
      await expectRevert(relay.verify(newMessageData.protocolId, newMessageData.votingRoundId, specificHash, proof, { value: 999 }), "too low fee");
      await relay.verify(newMessageData.protocolId, newMessageData.votingRoundId, specificHash, proof, { value: 1000 });
      const newBalance = Number(await web3.eth.getBalance(BURN_ADDRESS));
      expect(newBalance - oldBalance).to.equal(1000);
    });
  });

  describe("Custom hash signing", async () => {
    it("Should verification work", async () => {
      const signingPolicyData = defaultTestSigningPolicy(
        signers.map(x => x.address),
        N,
        singleWeight
      );
      signingPolicyData.rewardEpochId = rewardEpochId;
      signingPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(rewardEpochId);
      const signingPolicy = SigningPolicy.encode(signingPolicyData);
      const localHash = SigningPolicy.hashEncoded(signingPolicy);

      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: localHash,
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay = await Relay.new(
        relayInitialConfig,
        constants.ZERO_ADDRESS
      );

      const specificHash = web3.utils.keccak256("Something");

      const newMessageData = { ...messageData };
      newMessageData.merkleRoot = specificHash;
      newMessageData.votingRoundId = 0;
      newMessageData.isSecureRandom = false;
      newMessageData.protocolId = 1;
      const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);
      const signatures = await generateSignatures(
        accountPrivateKeys,
        messageHash,
        N / 2 + 1
      );

      const relayMessage = {
        signingPolicy: signingPolicyData,
        signatures,
        protocolMessageMerkleRoot: newMessageData,
      };

      let fullData = RelayMessage.encode(relayMessage);
      const result = await web3.eth.call({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      })
      expect(result.slice(0, 66)).to.equal(newMessageData.merkleRoot);
      expect(parseInt(result.slice(66), 16)).to.equal(rewardEpochId);
      newMessageData.votingRoundId = 1;
      fullData = RelayMessage.encode(relayMessage);
      await expectRevert(web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      }), "Wrong message format");
      newMessageData.votingRoundId = 0;
      newMessageData.isSecureRandom = true;
      fullData = RelayMessage.encode(relayMessage);
      await expectRevert(web3.eth.sendTransaction({
        from: signers[0].address,
        to: relay.address,
        data: selector + fullData.slice(2),
      }), "Wrong message format2");
    });
  });

  describe("Governance fee changing", async () => {
    it("Should fee be changed through signer governance", async () => {
      const signingPolicyData = defaultTestSigningPolicy(
        signers.map(x => x.address),
        N,
        singleWeight
      );
      signingPolicyData.rewardEpochId = rewardEpochId;
      signingPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(rewardEpochId);
      const signingPolicy = SigningPolicy.encode(signingPolicyData);
      const localHash = SigningPolicy.hashEncoded(signingPolicy);

      async function relayNewSigningPolicy(newRewardEpochId: number, relayAddress: string) {
        const prevSigningPolicyData = { ...signingPolicyData };
        prevSigningPolicyData.rewardEpochId = newRewardEpochId - 1;
        const newSigningPolicyDataRelayed = { ...signingPolicyData };
        newSigningPolicyDataRelayed.rewardEpochId = newRewardEpochId;
        const localHash = SigningPolicy.hash(newSigningPolicyDataRelayed);
        const signatures = await generateSignatures(
          accountPrivateKeys,
          localHash,
          N / 2 + 1
        );
        const relayMessage = {
          signingPolicy: prevSigningPolicyData,
          signatures,
          newSigningPolicy: newSigningPolicyDataRelayed
        };
        const fullData = RelayMessage.encode(relayMessage);

        return await web3.eth.sendTransaction({
          from: signers[0].address,
          to: relayAddress,
          data: selector + fullData.slice(2),
        })
      }

      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: localHash,
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: constants.ZERO_ADDRESS,
        feeConfigs: []
      }

      const relay = await Relay.new(
        relayInitialConfig,
        constants.ZERO_ADDRESS
      );

      const chainId = await web3.eth.getChainId();

      const NEW_FEE = "1000";
      const newRelayGovernanceConfig: RelayGovernanceConfig = {
        descriptionHash: relayGovernanceDescriptionHash,
        chainId,
        newFeeConfigs: [
          {
            protocolId: 2,
            feeInWei: NEW_FEE
          }
        ]
      }

      async function prepareRelayMessage(config: RelayGovernanceConfig, numSignatures = N / 2 + 1, protocolId = 1, votingRoundId = 0, newRewardEpochId?: number) {
        const newMessageData = { ...messageData };
        newMessageData.merkleRoot = specificHash;
        newMessageData.votingRoundId = votingRoundId;
        newMessageData.isSecureRandom = false;
        newMessageData.protocolId = protocolId;
        const messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);
        const signatures = await generateSignatures(
          accountPrivateKeys,
          messageHash,
          numSignatures
        );

        const tmpSigningPolicyData = { ...signingPolicyData };
        if (newRewardEpochId) {
          tmpSigningPolicyData.rewardEpochId = rewardEpochId;
        }
        const relayMessage = {
          signingPolicy: tmpSigningPolicyData,
          signatures,
          protocolMessageMerkleRoot: newMessageData,
        };
        let fullData = RelayMessage.encode(relayMessage);
        return selector + fullData.slice(2)
      }
      let specificHash = hashRelayGovernanceConfig(newRelayGovernanceConfig);

      for (let feeChange of newRelayGovernanceConfig.newFeeConfigs) {
        expect((await relay.protocolFeeInWei(feeChange.protocolId)).toString()).to.equal("0");
        await relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig), newRelayGovernanceConfig);
        expect((await relay.protocolFeeInWei(feeChange.protocolId)).toString()).to.equal(NEW_FEE);
      }

      newRelayGovernanceConfig.descriptionHash = web3.utils.keccak256("Something else");
      await expectRevert(relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig), newRelayGovernanceConfig), "wrong description hash");
      newRelayGovernanceConfig.descriptionHash = relayGovernanceDescriptionHash;
      newRelayGovernanceConfig.chainId = newRelayGovernanceConfig.chainId + 1;
      await expectRevert(relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig), newRelayGovernanceConfig), "wrong chain id");
      newRelayGovernanceConfig.chainId = newRelayGovernanceConfig.chainId - 1;
      await expectRevert(relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig, Math.round(N / 4)), newRelayGovernanceConfig), "Verification failed");
      await expectRevert(relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig, N / 2 + 1, 5, signingPolicyData.startVotingRoundId), newRelayGovernanceConfig), "Wrong verification data");

      const tmpRelayGovernanceConfig = { ...newRelayGovernanceConfig };
      tmpRelayGovernanceConfig.newFeeConfigs = tmpRelayGovernanceConfig.newFeeConfigs.map(x => ({ ...x }));
      tmpRelayGovernanceConfig.newFeeConfigs[0].feeInWei = NEW_FEE + "1";
      await expectRevert(relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig), tmpRelayGovernanceConfig), "Invalid config hash");

      await relayNewSigningPolicy(signingPolicyData.rewardEpochId + 1, relay.address);
      await relayNewSigningPolicy(signingPolicyData.rewardEpochId + 2, relay.address);
      await expectRevert(relay.governanceFeeSetup(await prepareRelayMessage(newRelayGovernanceConfig), newRelayGovernanceConfig), "too old signing policy");
    });
  });

  describe("Random number test", async () => {
    it("Should historical random number work", async () => {
      const signingPolicyData = defaultTestSigningPolicy(
        signers.map(x => x.address),
        N,
        singleWeight
      );
      signingPolicyData.rewardEpochId = rewardEpochId;
      signingPolicyData.startVotingRoundId = firstVotingRoundInRewardEpoch(rewardEpochId);
      const signingPolicy = SigningPolicy.encode(signingPolicyData);
      const localHash = SigningPolicy.hashEncoded(signingPolicy);

      const relayInitialConfig: RelayInitialConfig = {
        initialRewardEpochId: signingPolicyData.rewardEpochId,
        startingVotingRoundIdForInitialRewardEpochId: signingPolicyData.startVotingRoundId,
        initialSigningPolicyHash: localHash,
        randomNumberProtocolId: randomNumberProtocolId,
        firstVotingRoundStartTs: firstVotingRoundStartSec,
        votingEpochDurationSeconds: votingRoundDurationSec,
        firstRewardEpochStartVotingRoundId: firstRewardEpochVotingRoundId,
        rewardEpochDurationInVotingEpochs: rewardEpochDurationInVotingEpochs,
        thresholdIncreaseBIPS: THRESHOLD_INCREASE,
        messageFinalizationWindowInRewardEpochs: MESSAGE_FINALIZATION_WINDOW_IN_REWARD_EPOCHS,
        feeCollectionAddress: BURN_ADDRESS,
        feeConfigs: []
      }

      const relay = await Relay.new(
        relayInitialConfig,
        constants.ZERO_ADDRESS
      );

      const hashes = new Map<number, string>();
      const isSecure = new Map<number, boolean>();
      const startVotingRoundId = signingPolicyData.startVotingRoundId;
      const MAX_NUM = 1000;
      const STEP = 39;
      for (let i = 0; i < MAX_NUM; i += STEP) {
        const random = Math.random() > 0.5;
        const specificHash = web3.utils.keccak256(`hash${i}`);
        hashes.set(startVotingRoundId + i, specificHash);
        isSecure.set(startVotingRoundId + i, random);
        const newMessageData = {
          merkleRoot: specificHash,
          votingRoundId: startVotingRoundId + i,
          isSecureRandom: random,
          protocolId: randomNumberProtocolId
        };
        let messageHash = ProtocolMessageMerkleRoot.hash(newMessageData);
        let signatures = await generateSignatures(
          accountPrivateKeys,
          messageHash,
          N / 2 + 1
        );

        let relayMessage = {
          signingPolicy: signingPolicyData,
          signatures,
          protocolMessageMerkleRoot: newMessageData,
        };

        let fullData = RelayMessage.encode(relayMessage);
        await web3.eth.sendTransaction({
          from: signers[0].address,
          to: relay.address,
          data: selector + fullData.slice(2),
        })

        let { _randomNumber, _isSecureRandom, _randomTimestamp } = await relay.getRandomNumber();
        expect(_isSecureRandom).to.equal(random);
        expect(_randomNumber.toString()).to.equal(BigInt(web3.utils.keccak256(newMessageData.merkleRoot)).toString());
        expect(_randomTimestamp.toNumber()).to.equal(firstVotingRoundStartSec + votingRoundDurationSec * (newMessageData.votingRoundId + 1));
        expect((await relay.getVotingRoundId(_randomTimestamp)).toNumber()).to.be.equal(toBN(newMessageData.votingRoundId + 1));

        ({ _randomNumber, _isSecureRandom, _randomTimestamp } = await relay.getRandomNumberHistorical(newMessageData.votingRoundId));
        expect(_randomNumber.toString()).to.equal(BigInt(web3.utils.keccak256(newMessageData.merkleRoot)).toString());
        expect(_randomTimestamp.toNumber()).to.equal(firstVotingRoundStartSec + votingRoundDurationSec * (newMessageData.votingRoundId + 1));
        expect(_isSecureRandom).to.equal(random);
      }

      for (let i = 0; i < MAX_NUM; i++) {
        const votingRoundId = startVotingRoundId + i;
        if (hashes.get(votingRoundId)) {
          const { _randomNumber, _isSecureRandom, _randomTimestamp } = await relay.getRandomNumberHistorical(votingRoundId);
          expect(_randomNumber.toString()).to.equal(BigInt(web3.utils.keccak256(hashes.get(votingRoundId)!)).toString());
          expect(_randomTimestamp.toNumber()).to.equal(firstVotingRoundStartSec + votingRoundDurationSec * (votingRoundId + 1));
          expect(_isSecureRandom).to.equal(isSecure.get(votingRoundId));
        } else {
            await expectRevert(relay.getRandomNumberHistorical(votingRoundId), "no random number");
        }
      }
    });
  });
});
