// Auto setup GitHub: bot membuat / memperbarui file workflow di repo lewat API (tanpa upload manual)
const S = require('../setting');
const gh = require('./github');

// "§" diganti "$" supaya tidak bentrok dengan template literal JS
const fix = (x) => x.replace(/§/g, '$');

const CHAIN = () => (S.flutterChain && S.flutterChain.length ? S.flutterChain : [{ label: 'Terbaru', value: '' }]);

// Error yang kemungkinan besar karena versi Flutter/Gradle/AGP tidak cocok -> coba Flutter berikutnya
const VERSIONISH = "minimum supported version|No named parameter|isn.t defined|is not defined|Undefined (name|class|method)|The (getter|method|named parameter)|Dart SDK|SDK version|version solving|requires Flutter|Unsupported (class file|Gradle|Kotlin)|Android Gradle Plugin|incompatible|Kotlin.*version|NoSuchMethod|compileSdk";

const FIND_ROOT = `
          mkdir -p source
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "*.zip" --dir source
          cd source
          unzip -q -o ./source.zip || unzip -q -o ./*.zip
          PUB=$(find . -name pubspec.yaml -not -path '*/__MACOSX/*' -not -path '*/.dart_tool/*' -not -path '*/ephemeral/*' -not -path '*/example/*' -not -path '*/.symlinks/*' | awk '{print length, $0}' | sort -n | sed -n '1p' | cut -d' ' -f2- || true)
          if [ -z "$PUB" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            echo "::error::pubspec.yaml tidak ditemukan di dalam ZIP. Zip folder project Flutter yang ada pubspec.yaml."
            exit 1
          fi
          ROOT=$(cd "$(dirname "$PUB")" && pwd)
          echo "PROJECT_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Project root: $ROOT"`;

const FIXMS = String.raw`          cat > /tmp/fixminsdk.py <<'PY'
          import re, glob, os
          t = int(os.environ['MS'])
          files = glob.glob('android/app/build.gradle') + glob.glob('android/app/build.gradle.kts')
          rx = re.compile(r'(minSdk(?:Version)?)(\s*=?\s*)(\d+|flutter\.minSdkVersion)')
          def fix(m):
              v = m.group(3)
              if v.isdigit() and int(v) >= t:
                  return m.group(0)
              return m.group(1) + m.group(2) + str(t)
          for f in files:
              src = open(f, encoding='utf-8').read()
              out = rx.sub(fix, src)
              if out != src:
                  open(f, 'w', encoding='utf-8').write(out)
                  print('minSdk dinaikkan ke', t, 'di', f)
          PY`;

// Flutter -> Dart SDK (major*100+minor). Versi yang Dart-nya lebih rendah dari syarat pubspec dilewati (hemat menit)
const DARTOF = { '3.29': 307, '3.32': 308, '3.35': 309, '3.38': 310, '3.41': 311, '3.44': 312 };
const dartCond = (v) => {
  const m = String(v || '').match(/^(\d+\.\d+)/);
  const d = m && DARTOF[m[1]];
  return d ? ` && fromJSON(env.DARTMIN || '0') <= ${d}` : '';
};

function attempt(kind, i, v, label, cond = '') {
  cond += dartCond(v);
  const apk = kind === 'apk';
  return `
      - name: Setup Flutter ${label}
        if: env.BUILD_DONE != '1'${cond}
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '${v}'
          channel: stable
          cache: true

      - name: Build dengan Flutter ${label}
        if: env.BUILD_DONE != '1'${cond}
        run: |
          cd "$PROJECT_ROOT"
          set +e
          rm -rf .dart_tool build
          flutter --version
${apk ? `          if [ ! -d android ]; then
            echo "::notice::Folder android/ tidak ada, dibuat otomatis (flutter create)"
            cp pubspec.yaml /tmp/pubspec.keep; [ -d lib ] && cp -r lib /tmp/lib.keep
            flutter create . --platforms=android --project-name "$(grep -m1 '^name:' pubspec.yaml | awk '{print $2}' | tr -cd 'a-z0-9_')" --org com.base > /tmp/create.log 2>&1 || tail -5 /tmp/create.log
            cp /tmp/pubspec.keep pubspec.yaml; [ -d /tmp/lib.keep ] && { rm -rf lib; cp -r /tmp/lib.keep lib; }
          fi
` : `          if [ ! -d web ]; then
            echo "::notice::Folder web/ tidak ada, dibuat otomatis (flutter create)"
            cp pubspec.yaml /tmp/pubspec.keep; [ -d lib ] && cp -r lib /tmp/lib.keep
            flutter create . --platforms=web --project-name "$(grep -m1 '^name:' pubspec.yaml | awk '{print $2}' | tr -cd 'a-z0-9_')" --org com.base > /tmp/create.log 2>&1 || tail -5 /tmp/create.log
            cp /tmp/pubspec.keep pubspec.yaml; [ -d /tmp/lib.keep ] && { rm -rf lib; cp -r /tmp/lib.keep lib; }
          fi
`}
          LOG=/tmp/build-${i}.log
          NT=0
          SHRINK_OFF='${S.build && S.build.shrink === false ? ' --no-shrink' : ''}'
${apk ? `          if [ "§{{ inputs.build_type }}" = "debug" ]; then
            ARGS="--debug --target-platform android-arm64"
          else
            ARGS="--release --target-platform android-arm64 --split-debug-info=/tmp/dbg§{SHRINK_OFF}"
          fi
` : ''}          for t in 1 2 3; do
            flutter pub get 2>&1 | tee $LOG
            RC=§{PIPESTATUS[0]}
            [ "$RC" -eq 0 ] && break
            grep -Eiq 'version solving|requires|incompatible|resolve' $LOG && ! grep -Eiq 'timed out|connection|socket|HandshakeException|5[0-9][0-9]' $LOG && break
            echo "::warning::pub get gagal, coba lagi ($t/3)"; sleep 4
          done
          if [ "$RC" -eq 0 ]; then
            for n in 1 2 3 4 5; do
              ${apk ? 'flutter build apk --no-pub $ARGS' : 'flutter build web --release --no-pub'} 2>&1 | tee $LOG
              RC=§{PIPESTATUS[0]}
              [ "$RC" -eq 0 ] && break
              if [ "$NT" -lt 2 ] && grep -Eiq 'Could not (resolve|GET|HEAD|download)|Connection (reset|refused)|Read timed out|Connect timed out|Premature end|Received fatal alert|HTTP (5[0-9][0-9])|Unexpected end of stream|Remote host terminated' $LOG; then
                NT=$((NT+1)); echo "::warning::Gangguan jaringan saat build, mengulang ($NT/2)"; sleep 5; continue
              fi
${apk ? `              if ! echo "$ARGS" | grep -q -- '--no-shrink' && echo "$ARGS" | grep -q -- '--release' && grep -Eiq 'R8|minifyReleaseWithR8|Missing classes|proguard|shrinkReleaseRes|missing_rules' $LOG; then
                ARGS="$ARGS --no-shrink"; echo "::notice::Shrink (R8) gagal, mengulang tanpa shrink"; continue
              fi
` : ''}${apk ? `              M=$(grep -o "cannot be smaller than version [0-9]*" $LOG | head -1 | grep -o '[0-9]*$')
              [ -z "$M" ] && break
              echo "::notice::minSdk dinaikkan ke $M lalu build diulang"
              MS=$M python3 /tmp/fixminsdk.py
` : ''}            done
          fi
          if [ "$RC" -eq 0 ]; then
            echo "BUILD_DONE=1" >> "$GITHUB_ENV"
            echo "BUILD_OK=1" >> "$GITHUB_ENV"
            echo "::notice::Build sukses dengan Flutter ${label}"
          elif ! grep -Eiq '${VERSIONISH}' $LOG; then
            echo "BUILD_DONE=1" >> "$GITHUB_ENV"
            echo "Error bukan masalah versi Flutter, tidak mencoba versi lain."
          else
            echo "::warning::Gagal di Flutter ${label}, mencoba versi lain..."
          fi
          exit 0
`;
}

function workflow(kind) {
  const apk = kind === 'apk';
  // Flutter terbaru hanya dicoba PERTAMA kalau project sudah Gradle/AGP 9+ (atau web); selain itu dicoba TERAKHIR
  const chain = CHAIN();
  const latest = chain.find((c) => c.value === '') || { label: 'terbaru', value: '' };
  const rest = chain.filter((c) => c.value !== '');
  const attempts = attempt(kind, 'a', latest.value, latest.label + ' (prioritas)', " && env.PREFER_LATEST == '1'")
    + rest.map((c, i) => attempt(kind, i, c.value, c.label)).join('')
    + attempt(kind, 'z', latest.value, latest.label + ' (terakhir)', " && env.PREFER_LATEST != '1'");
  return fix(`name: ${apk ? 'Build Flutter' : 'Build Flutter Web'}
run-name: Build §{{ inputs.tag }} (${apk ? '§{{ inputs.build_type }}' : 'web'})

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true
${apk ? `      build_type:
        description: release atau debug
        default: release
` : ''}
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      CI: 'true'
      FLUTTER_SUPPRESS_ANALYTICS: 'true'
      PUB_ENVIRONMENT: bot_build
    steps:
${apk ? `      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
` : ''}
      - name: Kunci cache mingguan
        run: echo "WK=$(date +%G-%V)" >> "$GITHUB_ENV"

      - uses: actions/cache@v4
        with:
          path: |
${apk ? `            ~/.gradle/caches
            ~/.gradle/wrapper
            ~/.gradle/native
            ~/.android/build-cache
` : ''}            ~/.pub-cache
          key: ${apk ? 'gradle-pub' : 'pub'}-§{{ runner.os }}-§{{ env.WK }}
          restore-keys: |
            ${apk ? 'gradle-pub' : 'pub'}-§{{ runner.os }}-

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |${FIND_ROOT}

      - name: Deteksi versi Dart minimal project
        run: |
          cd "$PROJECT_ROOT"
          L=$(grep -E '^[[:space:]]+sdk:[[:space:]]*.?[>=^<]' pubspec.yaml | head -1 | grep -oE '[0-9]+[.][0-9]+' | head -1 || true)
          if [ -n "$L" ]; then
            echo "DARTMIN=$(( §{L%%.*} * 100 + §{L##*.} ))" >> "$GITHUB_ENV"
            echo "Dart minimal project: $L (versi Flutter yang terlalu lama dilewati)"
          fi
${apk ? `
      - name: Auto-fix minSdk (minimal 24)
        run: |
          cd "$PROJECT_ROOT"
${FIXMS}
          MS=24 python3 /tmp/fixminsdk.py
` : ''}
${apk ? `
      - name: Deteksi Gradle/AGP project
        run: |
          cd "$PROJECT_ROOT"
          GV=$(grep -o 'gradle-[0-9]*' android/gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 | grep -o '[0-9]*$' || true)
          AV=$(cat android/settings.gradle android/settings.gradle.kts android/build.gradle android/build.gradle.kts 2>/dev/null | grep -oE 'com[.]android[.](application|tools[.]build:gradle)[^0-9]{0,40}[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
          echo "Gradle major: §{GV:-?}, AGP major: §{AV:-?}"
          if [ "§{GV:-0}" -ge 9 ] || [ "§{AV:-0}" -ge 9 ]; then
            echo "PREFER_LATEST=1" >> "$GITHUB_ENV"
            echo "::notice::Project Gradle/AGP 9+, mulai dari Flutter terbaru"
          fi
` : `
      - name: Prioritas Flutter terbaru (web)
        run: echo "PREFER_LATEST=1" >> "$GITHUB_ENV"
`}
${apk ? `
      - name: Bersihkan opsi Gradle usang (dihapus di AGP baru)
        run: |
          cd "$PROJECT_ROOT"
          for f in android/gradle.properties; do
            [ -f "$f" ] || continue
            sed -i -E '/^[[:space:]]*android[.](enableDexingArtifactTransform([.]desugaring)?|enableD8([.]desugaring)?|enableR8|useDeprecatedNdk|enableUnitTestBinaryResources|enableBuildCache|enableAapt2|enableSeparateAnnotationProcessing)[[:space:]]*=/d' "$f"
            echo "gradle.properties dibersihkan dari opsi usang"
          done
` : ''}
${apk ? `      - name: Optimasi Gradle
        run: |
          AV=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
          if [ "§{AV:-99}" -lt 8 ]; then sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/share/boost; fi
          mkdir -p ~/.gradle
          {
            echo 'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g'
            echo 'org.gradle.parallel=true'
            echo 'org.gradle.caching=true'
            echo 'org.gradle.configureondemand=true'
            echo 'org.gradle.vfs.watch=false'
            echo 'kotlin.compiler.execution.strategy=in-process'
            echo 'kotlin.incremental=true'
            echo 'android.enableJetifier=false'
          } >> ~/.gradle/gradle.properties
          # lewati lintVital (lambat, tidak berpengaruh ke APK)
          mkdir -p ~/.gradle/init.d
          echo 'allprojects { tasks.configureEach { t -> if (t.name.startsWith("lintVital") || t.name.startsWith("lintAnalyze") || t.name.startsWith("lintReport")) { t.enabled = false } } }' > ~/.gradle/init.d/skiplint.gradle
` : ''}
${attempts}
      - name: Cek hasil build
        if: env.BUILD_OK != '1'
        run: |
          echo "::error::Build gagal. Versi Flutter yang dicoba: ${[...CHAIN().filter((c) => c.value !== ''), CHAIN().find((c) => c.value === '') || { label: 'terbaru' }].map((c) => c.label).join(', ')}"
          for f in /tmp/build-*.log; do
            echo "=== $f ==="
            grep -iE 'error|failed|went wrong|minimum|cannot be smaller' "$f" | tail -30 || true
          done
          exit 1

      - uses: actions/upload-artifact@v4
        with:
          name: ${apk ? 'app-§{{ inputs.build_type }}' : 'web-build'}
          path: §{{ env.PROJECT_ROOT }}/${apk ? 'build/app/outputs/flutter-apk/*.apk' : 'build/web'}
          if-no-files-found: error
          retention-days: 1
          compression-level: 0
`);
}

const FLUTTER = workflow('apk');
const WEB = workflow('web');
const HTML = htmlWorkflow();


// HTML -> APK: bungkus folder web (index.html) ke WebView Android. Tanpa Flutter/npm, jadi cepat.
function htmlWorkflow() {
  return fix(`name: Build HTML to APK
run-name: Build §{{ inputs.tag }} (html)

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.10.2'

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |
          mkdir -p source
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "*.zip" --dir source
          mkdir -p meta
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "icon.png" --pattern "meta.txt" --dir meta || true
          cd source
          unzip -q -o ./source.zip || unzip -q -o ./*.zip
          IDX=$(find . -iname index.html -not -path '*/__MACOSX/*' -not -path '*/node_modules/*' | awk '{print length, $0}' | sort -n | sed -n '1p' | cut -d' ' -f2- || true)
          if [ -z "$IDX" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            echo "::error::index.html tidak ditemukan di dalam ZIP. Zip folder web yang berisi index.html."
            exit 1
          fi
          ROOT=$(cd "$(dirname "$IDX")" && pwd)
          echo "WEB_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Web root: $ROOT"

      - name: Buat project Android (WebView)
        run: |
          set -e
          H=$(echo "§{{ inputs.tag }}" | md5sum | cut -c1-8)
          META="$GITHUB_WORKSPACE/meta"
          TITLE=""
          [ -f "$META/meta.txt" ] && TITLE=$(head -1 "$META/meta.txt" | tr -cd '[:alnum:] _.-' | cut -c1-30 || true)
          [ -z "$TITLE" ] && TITLE=$(grep -io '<title>[^<]*' "$WEB_ROOT/index.html" | head -1 | sed 's/<[tT][iI][tT][lL][eE]>//' | tr -cd '[:alnum:] _.-' | cut -c1-40 || true)
          [ -z "$TITLE" ] && TITLE="Web App"
          PLAT=$(ls "$ANDROID_HOME/platforms" | sed 's/android-//' | grep -E '^[0-9]+$' | sort -n | tail -1)
          BT=$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)
          echo "Android platform $PLAT, build-tools $BT, title: $TITLE"
          echo "APP_ID=com.htmlapk.a$H" >> "$GITHUB_ENV"
          echo "APP_TITLE=$TITLE" >> "$GITHUB_ENV"
          echo "COMPILE_SDK=$PLAT" >> "$GITHUB_ENV"
          echo "BUILD_TOOLS=$BT" >> "$GITHUB_ENV"
          A=/tmp/app
          mkdir -p $A/app/src/main/java/com/htmlapk/web $A/app/src/main/assets/www $A/app/src/main/res/values
          cp -r "$WEB_ROOT"/. $A/app/src/main/assets/www/
          rm -rf $A/app/src/main/assets/www/__MACOSX
          ICON_RES=@android:drawable/sym_def_app_icon
          if [ -f "$META/icon.png" ]; then
            for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
              mkdir -p $A/app/src/main/res/mipmap-§{d%%:*}
              SZ=§{d##*:}
              OUT=$A/app/src/main/res/mipmap-§{d%%:*}/ic_launcher.png
              convert "$META/icon.png[0]" -background none -resize §{SZ}x§{SZ}^ -gravity center -extent §{SZ}x§{SZ} "PNG32:$OUT" 2>/dev/null \
                || magick "$META/icon.png[0]" -background none -resize §{SZ}x§{SZ}^ -gravity center -extent §{SZ}x§{SZ} "PNG32:$OUT" 2>/dev/null \
                || cp "$META/icon.png" "$OUT"
            done
            ICON_RES=@mipmap/ic_launcher
          else
            ICON_RES=@android:drawable/sym_def_app_icon
          fi
          echo "<resources><string name=\\"app_name\\">$TITLE</string></resources>" > $A/app/src/main/res/values/strings.xml
          {
            echo "android.suppressUnsupportedCompileSdk=$PLAT"
            echo "org.gradle.jvmargs=-Xmx3g"
            echo "org.gradle.parallel=true"
            echo "org.gradle.caching=true"
          } > $A/gradle.properties
          cat > $A/settings.gradle <<'EOF'
          pluginManagement {
            repositories { google(); mavenCentral(); gradlePluginPortal() }
          }
          dependencyResolutionManagement {
            repositories { google(); mavenCentral() }
          }
          rootProject.name = 'htmlapk'
          include ':app'
          EOF
          cat > $A/build.gradle <<'EOF'
          plugins { id 'com.android.application' version '8.7.3' apply false }
          EOF
          cat > $A/app/build.gradle <<'EOF'
          plugins { id 'com.android.application' }
          android {
            namespace 'com.htmlapk.web'
            compileSdk System.getenv('COMPILE_SDK').toInteger()
            buildToolsVersion System.getenv('BUILD_TOOLS')
            defaultConfig {
              applicationId System.getenv('APP_ID')
              minSdk 21
              targetSdk 34
              versionCode 1
              versionName '1.0'
            }
            signingConfigs {
              release {
                storeFile file(System.getenv('KS_FILE'))
                storePassword 'android'
                keyAlias 'key'
                keyPassword 'android'
              }
            }
            buildTypes {
              release {
                signingConfig signingConfigs.release
                minifyEnabled false
                shrinkResources false
              }
            }
            lint { abortOnError false; checkReleaseBuilds false }
          }
          EOF
          cat > $A/app/src/main/AndroidManifest.xml <<'EOF'
          <?xml version="1.0" encoding="utf-8"?>
          <manifest xmlns:android="http://schemas.android.com/apk/res/android">
            <uses-permission android:name="android.permission.INTERNET"/>
            <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
            <application
              android:label="@string/app_name"
              android:icon="@android:drawable/sym_def_app_icon"
              android:usesCleartextTraffic="true"
              android:allowBackup="true"
              android:theme="@android:style/Theme.DeviceDefault.NoActionBar">
              <activity
                android:name=".MainActivity"
                android:exported="true"
                android:configChanges="orientation|screenSize|keyboardHidden|smallestScreenSize|screenLayout"
                android:windowSoftInputMode="adjustResize">
                <intent-filter>
                  <action android:name="android.intent.action.MAIN"/>
                  <category android:name="android.intent.category.LAUNCHER"/>
                </intent-filter>
              </activity>
            </application>
          </manifest>
          EOF
          sed -i "s#@android:drawable/sym_def_app_icon#$ICON_RES#" $A/app/src/main/AndroidManifest.xml
          cat > $A/app/src/main/java/com/htmlapk/web/MainActivity.java <<'EOF'
          package com.htmlapk.web;

          import android.app.Activity;
          import android.content.Intent;
          import android.net.Uri;
          import android.os.Bundle;
          import android.webkit.WebChromeClient;
          import android.webkit.WebResourceRequest;
          import android.webkit.WebSettings;
          import android.webkit.WebView;
          import android.webkit.WebViewClient;

          public class MainActivity extends Activity {
            private WebView web;

            @Override
            protected void onCreate(Bundle b) {
              super.onCreate(b);
              web = new WebView(this);
              setContentView(web);
              WebSettings s = web.getSettings();
              s.setJavaScriptEnabled(true);
              s.setDomStorageEnabled(true);
              s.setDatabaseEnabled(true);
              s.setAllowFileAccess(true);
              s.setAllowFileAccessFromFileURLs(true);
              s.setAllowUniversalAccessFromFileURLs(true);
              s.setMediaPlaybackRequiresUserGesture(false);
              s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
              web.setWebChromeClient(new WebChromeClient());
              web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                  String u = r.getUrl().toString();
                  if (u.startsWith("file:") || u.startsWith("http:") || u.startsWith("https:")
                      || u.startsWith("about:") || u.startsWith("data:") || u.startsWith("blob:")
                      || u.startsWith("javascript:")) return false;
                  try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception e) { }
                  return true;
                }
              });
              if (b != null) web.restoreState(b);
              else web.loadUrl("file:///android_asset/www/index.html");
            }

            @Override
            protected void onSaveInstanceState(Bundle o) {
              super.onSaveInstanceState(o);
              web.saveState(o);
            }

            @Override
            public void onBackPressed() {
              if (web.canGoBack()) web.goBack(); else super.onBackPressed();
            }
          }
          EOF

      - name: Buat keystore
        run: |
          keytool -genkeypair -keystore /tmp/app.jks -storepass android -keypass android -alias key -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=HTML APK" > /dev/null 2>&1
          echo "KS_FILE=/tmp/app.jks" >> "$GITHUB_ENV"

      - name: Build APK
        run: |
          yes | sdkmanager --licenses > /dev/null 2>&1 || true
          set -o pipefail
          cd /tmp/app
          for t in 1 2 3; do
            gradle assembleRelease --no-daemon --parallel --build-cache --console=plain 2>&1 | tee /tmp/build-html.log && break
            if [ "$t" -lt 3 ] && grep -Eiq 'Could not (resolve|GET|HEAD|download)|Connection (reset|refused)|timed out|Premature end|Received fatal alert|HTTP 5[0-9][0-9]' /tmp/build-html.log; then
              echo "::warning::Gangguan jaringan, mengulang ($t/3)"; sleep 6
            else
              exit 1
            fi
          done
          mkdir -p /tmp/out
          N=§{APP_TITLE// /_}
          cp app/build/outputs/apk/release/app-release.apk "/tmp/out/§{N}.apk"

      - uses: actions/upload-artifact@v4
        with:
          name: html-apk
          path: /tmp/out/*.apk
          if-no-files-found: error
          retention-days: 1
          compression-level: 0
`);
}

async function put(server, file, content, branch) {
  const p = `/repos/${server.repo}/contents/.github/workflows/${file}`;
  let sha;
  try {
    const cur = await gh.api('GET', `${p}?ref=${encodeURIComponent(branch)}`);
    if (Buffer.from(cur.content, 'base64').toString('utf8') === content) return 'sudah terbaru';
    sha = cur.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = { message: `bot: ${sha ? 'update' : 'tambah'} ${file}`, content: Buffer.from(content).toString('base64'), branch };
  if (sha) body.sha = sha;
  try {
    await gh.api('PUT', p, { body });
  } catch (e) {
    if (e.status === 404 || e.status === 409 || e.status === 422) { // repo kosong / branch belum ada
      delete body.branch;
      await gh.api('PUT', p, { body });
    } else throw e;
  }
  return sha ? 'diperbarui' : 'dibuat';
}

// Mengembalikan teks laporan; throw kalau token/repo salah
async function ensure(server) {
  const repo = await gh.api('GET', `/repos/${server.repo}`);
  if (!repo.permissions?.push) throw new Error('Token tidak punya akses push ke repo ini (butuh scope repo + workflow).');
  try {
    await gh.api('GET', `/repos/${server.repo}/branches/${encodeURIComponent(server.branch)}`);
  } catch (e) {
    if (e.status === 404 && repo.default_branch) { server.branch = repo.default_branch; require('./db').save(); }
  }
  const b = server.branch;
  const r1 = await put(server, S.github.flutterWorkflow, FLUTTER, b);
  const r2 = await put(server, S.github.webWorkflow, WEB, b);
  const hw = S.github.htmlWorkflow || 'build-html.yml';
  const r3 = await put(server, hw, HTML, b);
  return `📱 ${S.github.flutterWorkflow}: ${r1}\n🌐 ${S.github.webWorkflow}: ${r2}\n🧱 ${hw}: ${r3}\n🌿 Branch: ${server.branch}`;
}

const files = () => ({ [S.github.flutterWorkflow]: FLUTTER, [S.github.webWorkflow]: WEB, [S.github.htmlWorkflow || 'build-html.yml']: HTML });

// cek cepat sebelum dipasang: harus ada trigger, run-name, dan tidak ada sisa placeholder
function selfCheck() {
  const bad = [];
  for (const [name, y] of Object.entries(files())) {
    if (!/workflow_dispatch/.test(y)) bad.push(`${name}: tanpa workflow_dispatch`);
    if (!/run-name:/.test(y)) bad.push(`${name}: tanpa run-name`);
    if (/§|\$\{\{\s*\}\}/.test(y)) bad.push(`${name}: sisa placeholder`);
    if (/\t/.test(y)) bad.push(`${name}: ada karakter TAB`);
  }
  return bad;
}


// Diagnosa + perbaikan menyeluruh workflow di repo server (owner): pasang versi terbaru, pastikan GitHub benar-benar
// mem-parse-nya (YAML valid), workflow aktif, dan Actions diizinkan. Mengembalikan teks laporan.
async function repair(server) {
  const out = [];
  const bad = selfCheck();
  if (bad.length) return `❌ Template bot bermasalah, tidak dipasang:\n${bad.join('\n')}`;
  const repo = await gh.api('GET', `/repos/${server.repo}`);
  if (!repo.permissions?.push) throw new Error('Token tidak punya akses push (butuh scope repo + workflow).');
  if (repo.archived) throw new Error('Repo diarsipkan (read-only). Un-archive dulu di GitHub.');

  // 1. Actions aktif?
  try {
    const perm = await gh.api('GET', `/repos/${server.repo}/actions/permissions`);
    if (perm.enabled === false) {
      await gh.api('PUT', `/repos/${server.repo}/actions/permissions`, { body: { enabled: true, allowed_actions: 'all' } });
      out.push('🔧 GitHub Actions di repo diaktifkan');
    } else out.push('✅ GitHub Actions aktif');
  } catch (e) { out.push(`⚠️ Cek izin Actions dilewati (${e.status || e.message})`); }

  // 2. pasang / perbarui file
  out.push(await ensure(server));

  // 3. verifikasi tiap workflow
  await new Promise((r) => setTimeout(r, 4000));
  for (const [file, content] of Object.entries(files())) {
    try {
      const wf = await gh.api('GET', `/repos/${server.repo}/actions/workflows/${encodeURIComponent(file)}`);
      const first = (content.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
      const parsed = !first || wf.name === first;
      let state = wf.state;
      if (state && state !== 'active') {
        try { await gh.api('PUT', `/repos/${server.repo}/actions/workflows/${wf.id}/enable`); state = 'active (diaktifkan ulang)'; } catch { /* abaikan */ }
      }
      out.push(`${parsed ? '✅' : '❌'} ${file}: ${parsed ? 'terbaca GitHub' : `YAML TIDAK terbaca (nama "${wf.name}")`} • ${state}`);
    } catch (e) {
      out.push(`❌ ${file}: tidak ditemukan di GitHub (${e.status || e.message}). Tunggu 1 menit lalu jalankan lagi.`);
    }
  }
  return out.join('\n');
}

module.exports = { ensure, files, selfCheck, repair };
