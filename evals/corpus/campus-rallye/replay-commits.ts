import type { ReplayCommit } from "../contracts.js";

const effect = "useEffect(() => {";

const imagePublicUrl = {
  cases: [
    {
      action: "delete-derived-state",
      expected: "non-enforced",
      file: "components/rallye/questions/ImageQuestion.tsx",
      line: 26,
      rationale:
        "pictureUri is written only by the effect from question.bucket_path, but it starts null, so the first commit renders no image even when bucket_path is set. The effect also keeps the previous URL when bucket_path becomes empty, where the derivation returns null.",
      source: "useState<string | null>(null)",
    },
    {
      action: "delete-effect",
      expected: "non-enforced",
      file: "components/rallye/questions/ImageQuestion.tsx",
      line: 42,
      rationale:
        "The effect's only work is the pictureUri write, so it empties once that state is derived, which changes the first commit as labeled at line 26.",
      source: effect,
    },
  ],
  commit: "3b4ba15ed75ad7f976d7e8fe10ad140339017233",
  parent: "265a4c1443abee2ea8db66813bb52836b3d61443",
  repository: "campus-rallye",
  root: ".",
} as const satisfies ReplayCommit;

const votingCurrentQuestion = {
  cases: [
    {
      action: "delete-derived-state",
      expected: "non-enforced",
      file: "app/(tabs)/rallye/voting.tsx",
      line: 23,
      rationale:
        "currentQuestion is written only by the effect, a second render after each voting or index change, but only while counter > currentVotingIdx; otherwise it keeps the previous group. The derivation always shows grouped[currentVotingIdx], which differs in the commit before the same effect flips votingAllowed to false.",
      source: "useState<any[]>([])",
    },
    {
      expected: "excluded",
      file: "app/(tabs)/rallye/voting.tsx",
      line: 75,
      rationale:
        "The effect stays to write store$.votingAllowed; dropping voting from its dependencies follows from the derived-state edit at line 23, and a Legend set with an unchanged value notifies nobody.",
      source: effect,
    },
  ],
  commit: "12d2f0b745204e35db737bdf93510beb78ad5e58",
  parent: "3b4ba15ed75ad7f976d7e8fe10ad140339017233",
  repository: "campus-rallye",
  root: ".",
} as const satisfies ReplayCommit;

const cameraFacingState = {
  cases: [
    {
      action: "move-state-down",
      expected: "non-enforced",
      file: "screens/questions/UploadPhoto.jsx",
      line: 7,
      rationale:
        "Only PhotoCamera reads facing, and each toggle re-rendered UploadPhoto, which redefines the inline PhotoCamera and remounts the camera. PhotoCamera mounts only while picture is null, so moving the state resets facing to back after every retake, which the parent's state kept.",
      source: "useState('back')",
    },
  ],
  commit: "579ab6752825c4de2add652ca4979f76aa0dd1e5",
  parent: "f785c15baab44666ba430c82b2f0cb3dc1884964",
  repository: "campus-rallye",
  root: ".",
} as const satisfies ReplayCommit;

/** The CampusRallyeApp maintainer's derived-state and state-placement commits, classified against each parent tree. */
export const campusRallyeReplayCommits: readonly ReplayCommit[] = [
  imagePublicUrl,
  votingCurrentQuestion,
  cameraFacingState,
];
