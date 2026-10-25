import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tmp(prefix = 'stora-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function put(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function commit(root: string) {
  const run = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('-c', 'user.email=t@t.dev', '-c', 'user.name=t', 'add', '-A');
  run('-c', 'user.email=t@t.dev', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

/** A deliberately problematic Expo / React Native app. */
export function problemApp(): string {
  const root = tmp('fixture-problem-');
  put(root, {
    'package.json': JSON.stringify({
      name: 'fit-track',
      version: '1.2.0',
      description: 'Track workouts',
      dependencies: {
        expo: '^51.0.0',
        'react-native': '0.74.0',
        'react-native-google-mobile-ads': '^13.0.0',
        '@react-native-google-signin/google-signin': '^11.0.0',
        'react-native-fbsdk-next': '^12.0.0',
        'react-native-purchases': '^7.0.0',
        '@sentry/react-native': '^5.0.0',
      },
    }),
    'app.json': JSON.stringify({ expo: { name: 'Best Free Fit Tracker', slug: 'fit-track', version: '1.2.0' } }),
    'README.md': '# FitTrack\n\nFitTrack lets you log workouts, track progress charts and set weekly fitness goals.\n',
    'ios/FitTrack/Info.plist': `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>FitTrack</string>
<key>CFBundleIdentifier</key><string>com.acme.fittrack</string>
<key>NSCameraUsageDescription</key><string>Camera needed</string>
<key>NSLocationWhenInUseUsageDescription</key><string>$(PRODUCT_NAME) needs location</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict></plist>`,
    'android/app/build.gradle': 'android { defaultConfig { applicationId "com.acme.fittrack" } }',
    'android/app/src/main/AndroidManifest.xml': `<manifest package="com.acme.fittrack" xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.READ_SMS"/>
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
<uses-permission android:name="android.permission.CAMERA"/>
<application android:debuggable="true" android:usesCleartextTraffic="true"/></manifest>`,
    'src/screens/WorkoutLogScreen.tsx': 'export default function WorkoutLogScreen(){return null}',
    'src/screens/ProgressChartsScreen.tsx': 'export default function ProgressChartsScreen(){return null}',
    'src/screens/WeeklyGoalsScreen.tsx': 'export default function WeeklyGoalsScreen(){return null}',
    'src/screens/SettingsScreen.tsx': 'export default function SettingsScreen(){return null}',
    'src/screens/LoginScreen.tsx': 'export default function LoginScreen(){return null}',
    'src/config.ts': 'export const aws = "AKIAIOSFODNN7EXAMPLE";',
  });
  return commit(root);
}

/** A tidy Flutter app with a privacy URL, privacy manifest and good purpose strings. */
export function cleanApp(): string {
  const root = tmp('fixture-clean-');
  put(root, {
    'pubspec.yaml': 'name: recipe_box\ndescription: Save and organise your favourite recipes\nversion: 2.0.1+7\nflutter:\n  uses-material-design: true\ndependencies:\n  flutter:\n    sdk: flutter\n',
    'README.md':
      '# Recipe Box\n\nRecipe Box helps home cooks save recipes from the web, build weekly meal plans and generate shopping lists. ' +
      'It works offline and syncs across devices so your cookbook is always with you in the kitchen.\n\nPrivacy policy: https://recipebox.example/privacy\n',
    'ios/Runner/Info.plist': `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Recipe Box</string>
<key>CFBundleIdentifier</key><string>com.example.recipebox</string>
<key>NSCameraUsageDescription</key><string>Recipe Box uses the camera to scan recipe cards from cookbooks so you can save them digitally.</string>
</dict></plist>`,
    'ios/Runner/PrivacyInfo.xcprivacy': '<plist/>',
    'android/app/build.gradle': 'android { defaultConfig { applicationId "com.example.recipebox" } }',
    'android/app/src/main/AndroidManifest.xml': '<manifest package="com.example.recipebox" xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.CAMERA"/><application/></manifest>',
    'lib/screens/recipe_list_screen.dart': 'class RecipeListScreen {}',
    'lib/screens/meal_planner_screen.dart': 'class MealPlannerScreen {}',
    'lib/screens/shopping_list_screen.dart': 'class ShoppingListScreen {}',
  });
  return commit(root);
}
