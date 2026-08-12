import * as THREE from "three";
import { OrbitControls } from "./jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://unpkg.com/three@0.150.1/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "https://unpkg.com/@pixiv/three-vrm@3.4.2/lib/three-vrm.module.js";

const canvas = document.getElementById("webgl");
const renderer = new THREE.WebGLRenderer({ canvas });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
const textureLoader = new THREE.TextureLoader();
textureLoader.load("./background.png", (texture) => {
  scene.background = texture;
});

const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 1.6, 1.2);

// 環境光
const ambientLight = new THREE.AmbientLight(0xffeedd, 0.3); // やや暖かい白
scene.add(ambientLight);

// 半球光（上空・床の柔らかい反射）
const hemiLight = new THREE.HemisphereLight(0xfff8ee, 0x332211, 0.25); 
hemiLight.position.set(0, 1, 0);
scene.add(hemiLight);

// 主光源（アバターの顔や服をしっかり照らす）
const light = new THREE.DirectionalLight(0xfff0e0, 0.7); // 暖かめ
light.position.set(0.5, 1.6, 2); // 正面から
light.target.position.set(0, 1.6, 0); // 顔の高さ
scene.add(light.target);
scene.add(light);
const rimLight = new THREE.DirectionalLight(0x99ccff, 0.3); // 青系
rimLight.position.set(-1, 1.8, -1); // 後ろ上から
scene.add(rimLight);



// レンダラー補正
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;






const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.6, 0);
controls.update();

let currentVrm = null;
const clock = new THREE.Clock();

// ボーン参照
let headNode = null;
let leftArmNode = null;
let rightArmNode = null;

// マウス
let mouse = { x: 0, y: 0 };
document.addEventListener("mousemove", (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
});

const lookAtTarget = new THREE.Object3D();
scene.add(lookAtTarget);

let isFollowingMouse = false;
let followStartTime = 0;
let followDuration = 2.0;  // 追従時間
let nextFollowDelay = getRandomFollowDelay(); // 次回追従までのランダム間隔

function getRandomFollowDelay() {
  return 15 + Math.random() * 5;
}

function updateLookAtTarget() {
  if (!currentVrm || !headNode) return;

  const headWorldPos = new THREE.Vector3();
  headNode.getWorldPosition(headWorldPos);

  let targetPos = new THREE.Vector3();
  if (isFollowingMouse) {
    const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
    vector.unproject(camera);
    const dir = vector.sub(camera.position).normalize();
    targetPos.copy(camera.position).add(dir.multiplyScalar(10));
  } else {
    targetPos.copy(headWorldPos);
    targetPos.z += 10; // 正面方向
  }

  // 滑らかに補間
  lookAtTarget.position.lerp(targetPos, 0.005);
}

// --- 口パク用 ---
const mouthMeshes = [];
const lipsyncNames = ["Fcl_MTH_A", "Fcl_MTH_I", "Fcl_MTH_U", "Fcl_MTH_E", "Fcl_MTH_O"];
let lipsyncIndex = 0;
let lastSwitchTime = 0;
const lipsyncInterval = 0.12; // 秒
let lipSyncPlaying = false;
let lipSyncAutoStopTimer = null;

// --- 笑顔用 morph ---
let joyMeshes = []; // { mesh, idx }
let joyActive = false;
let joyStopTimer = null;

function setMouthShapeByName(shapeName, value) {
  mouthMeshes.forEach((entry) => {
    const mesh = entry.mesh;
    const idx = entry.indices[shapeName];
    if (typeof idx !== "undefined" && mesh.morphTargetInfluences) {
      mesh.morphTargetInfluences[idx] = value;
    }
  });
}

function resetAllMouthShapes() {
  mouthMeshes.forEach((entry) => {
    const mesh = entry.mesh;
    entry.allMthIndices.forEach((idx) => {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[idx] = 0.0;
    });
  });
}

// --- 瞬き用 ---
let blinkMeshes = []; // { mesh, idx }
let nextBlinkTime = 0;
let isBlinking = false;
let blinkStart = 0;
const blinkDuration = 0.12; // 0.12秒で閉じて開く


// GLTF/VRMロード
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  "./avatar.vrm",
  (gltf) => {
    const vrm = gltf.userData.vrm;
    currentVrm = vrm;
    currentVrm.scene.position.y += 0.5;
    scene.add(currentVrm.scene);

    // VRM LookAt
    const detectedVrmLookAt = currentVrm.userData?.vrmLookAt ?? currentVrm.lookAt ?? null;
    if (detectedVrmLookAt) {
      detectedVrmLookAt.target = lookAtTarget;
      if ("autoUpdate" in detectedVrmLookAt) detectedVrmLookAt.autoUpdate = true;
      currentVrm._activeVrmLookAt = detectedVrmLookAt;
    }

   


    // headNode
    currentVrm.scene.traverse((n) => {
      if (n.isBone && n.name === "J_Bip_C_Head") headNode = n;
      if (n.isBone && n.name === "J_Bip_L_UpperArm") leftArmNode = n;
      if (n.isBone && n.name === "J_Bip_R_UpperArm") rightArmNode = n;
      // 口パクメッシュ登録
      if (n.isMesh && n.morphTargetDictionary) {
        const mthKeys = Object.keys(n.morphTargetDictionary).filter((k) => k.startsWith("Fcl_MTH_"));
        if (mthKeys.length > 0) {
          const indices = {};
          const allIdx = [];
          mthKeys.forEach((k) => {
            const idx = n.morphTargetDictionary[k];
            indices[k] = idx;
            allIdx.push(idx);
          });
          mouthMeshes.push({ mesh: n, indices: indices, allMthIndices: allIdx });
        }

        // まばたき用 Fcl_EYE_Close を検出
        if ("Fcl_EYE_Close" in n.morphTargetDictionary) {
          const idx = n.morphTargetDictionary["Fcl_EYE_Close"];
          blinkMeshes.push({ mesh: n, idx });
          console.log("Blink mesh found:", n.name);
        }

        // 笑顔 "Fcl_ALL_Fun" を探す
        if ("Fcl_ALL_Fun" in n.morphTargetDictionary) {
          const idx = n.morphTargetDictionary["Fcl_ALL_Fun"];
          joyMeshes.push({ mesh: n, idx: idx });
          console.log("Joy morph mesh:", n.name);
        }
      }
    });
    currentVrm.humanoid?.resetNormalizedPose();
  },
  (progress) => console.log("Loading VRM...", (100.0 * progress.loaded / progress.total).toFixed(2), "%"),
  (err) => console.error(err)
);

function setJoy(value) {
  joyMeshes.forEach((entry) => {
    if (entry.mesh.morphTargetInfluences) {
      entry.mesh.morphTargetInfluences[entry.idx] = value;
    }
  });
}

let isFirstLipSync = true; // 初回判定フラグ

function updateBlink(elapsed) {
  if (blinkMeshes.length === 0) return;

  if (!isBlinking && elapsed > nextBlinkTime) {
    isBlinking = true;
    blinkStart = elapsed;
    nextBlinkTime = elapsed + 2 + Math.random() * 4; // 2~6秒間隔
  }

  if (isBlinking) {
    const t = (elapsed - blinkStart) / blinkDuration;

    let value = 0.0;
    if (t < 0.5) {
      value = t * 2; // 閉じる
    } else if (t < 1.0) {
      value = (1 - (t - 0.5) * 2); // 開く
    } else {
      value = 0;
      isBlinking = false;
    }

    blinkMeshes.forEach(entry => {
      if (entry.mesh.morphTargetInfluences) {
        entry.mesh.morphTargetInfluences[entry.idx] = value;
      }
    });
  }
}


// グローバル API
window.startLipSync = function(durationMs = null) {
  if (lipSyncAutoStopTimer) clearTimeout(lipSyncAutoStopTimer);
  if (joyStopTimer) clearTimeout(joyStopTimer);

  resetAllMouthShapes();

  // const delay = isFirstLipSync ? 6000 : 500;
  // isFirstLipSync = false;

  setTimeout(() => {
    lipSyncPlaying = true;
    joyActive = true; // 笑顔ON
    setJoy(1.0);

    lastSwitchTime = 0;
    lipsyncIndex = 0;

    if (durationMs && typeof durationMs === "number") {
      lipSyncAutoStopTimer = setTimeout(() => {
        window.stopLipSync();
      }, durationMs);
    }
  });
};

window.stopLipSync = function() {
  lipSyncPlaying = false;
  resetAllMouthShapes();
  if (lipSyncAutoStopTimer) clearTimeout(lipSyncAutoStopTimer);
  // 喋り終わったら3秒間笑顔を維持
  if (joyActive) {
    if (joyStopTimer) clearTimeout(joyStopTimer);
    joyStopTimer = setTimeout(() => {
      setJoy(0.0);
      joyActive = false;
    });
  }
};

// ウィンドウリサイズ対応
window.addEventListener("resize", () => {
  const width = window.innerWidth;
  const height = window.innerHeight;

  // カメラのアスペクト比を更新
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  // レンダラーのサイズを更新
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
});

// アニメーションループ
function animate() {
  requestAnimationFrame(animate);
  const deltaTime = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  if (currentVrm && headNode) {
    // 喋っている間は視線追従を停止
    if (lipSyncPlaying) {
      isFollowingMouse = false;
    }
    // ランダムでマウス追従開始判定
    if (!isFollowingMouse) {
      nextFollowDelay -= deltaTime;
      if (nextFollowDelay <= 0) {
        isFollowingMouse = true;
        followStartTime = elapsed;
        followDuration = getRandomFollowDelay();
        nextFollowDelay = getRandomFollowDelay();
      }
    } else {
      if (elapsed - followStartTime >= followDuration) {
        isFollowingMouse = false;
      }
    }

    // マウス追従中は笑顔ON
    // if (isFollowingMouse && !joyActive) {
    //   joyActive = true;
    //   setJoy(1.0);
    //   if (joyStopTimer) clearTimeout(joyStopTimer); // 停止タイマーリセット
    // } else if (!isFollowingMouse && joyActive && !lipSyncPlaying) {
    //   // マウス追従が終わったら3秒後に笑顔OFF
    //   if (joyStopTimer) clearTimeout(joyStopTimer);
    //   joyStopTimer = setTimeout(() => {
    //     setJoy(0.0);
    //     joyActive = false;
    //   }, 3000);
    // }

    // ターゲット更新
    updateLookAtTarget();

    // LookAt update
    const vrmLookAt = currentVrm.lookAt ?? currentVrm.userData.vrmLookAt;
    if (vrmLookAt && typeof vrmLookAt.update === "function") {
      vrmLookAt.update(deltaTime);
    } else {
      // LookAtなしの場合は首を直接回す
      const headWorldPos = new THREE.Vector3();
      headNode.getWorldPosition(headWorldPos);
      const dir = lookAtTarget.position.clone().sub(headWorldPos).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      const pitch = Math.asin(-dir.y);
      headNode.rotation.y = THREE.MathUtils.lerp(headNode.rotation.y, yaw, 0.05);
      headNode.rotation.x = THREE.MathUtils.lerp(headNode.rotation.x, pitch, 0.05);
    }

    // 首を微揺れ
    
    headNode.rotation.y = Math.sin(elapsed) * 0.05;

    // 瞬き
    updateBlink(elapsed);

    

    // 腕の微揺れ
    if (leftArmNode) leftArmNode.rotation.z = -1.1 + Math.sin(elapsed) * 0.05;
    if (rightArmNode) rightArmNode.rotation.z = 1.1 + Math.sin(elapsed + Math.PI) * 0.05;

    // 口パク
    if (lipSyncPlaying && mouthMeshes.length > 0) {

      const mouthSpeed = 2.5; // 開閉スピード調整、大きいほど速い
      const elapsedPhase = Math.sin(elapsed * mouthSpeed); // -1〜1の周期波
      const mouthValue = (elapsedPhase + 1) / 2; // 0〜1に正規化

      // 開き具合を少し変化（0.1〜0.8程度で自然に）
      const smoothedValue = 0.1 + mouthValue * 0.7;

      if (elapsed - lastSwitchTime > lipsyncInterval) {
        lipsyncIndex = Math.floor(Math.random() * lipsyncNames.length);
        lastSwitchTime = elapsed;
      }
      resetAllMouthShapes();
      setMouthShapeByName(lipsyncNames[lipsyncIndex], smoothedValue);
    }
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Python側のシグナルを受け取る ---
new QWebChannel(qt.webChannelTransport, (channel) => {
  window.bridge = channel.objects.bridge;

  // 音声開始 → 口パク開始
  bridge.playbackStarted.connect(() => {
    setTimeout(() => {
      window.startLipSync();
    }, 300);
  });

  // 音声終了 → 口パク停止
  bridge.playbackEnded.connect(() => {
    window.stopLipSync();
  });
});


