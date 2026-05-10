import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
    appId: 'jp.kannn.fruitshooter',
    appName: 'Fruit Shooter Draw',
    webDir: 'capacitor-www',
    bundledWebRuntime: false,
    server: {
        cleartext: true,
        allowNavigation: ['*'],
    },
    ios: {
        contentInset: 'always',
    },
}

export default config
