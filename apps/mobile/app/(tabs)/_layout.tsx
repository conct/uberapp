import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';

import { useTheme } from '../../src/ui/theme';

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.surface },
        headerTintColor: theme.text,
        headerTitleStyle: { fontWeight: '700' },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textFaint,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        sceneStyle: { backgroundColor: theme.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Übersicht',
          tabBarIcon: ({ color, size }) => <Ionicons name="pulse" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="services"
        options={{
          title: 'Services',
          tabBarIcon: ({ color, size }) => <Ionicons name="layers" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="web"
        options={{
          title: 'Web',
          tabBarIcon: ({ color, size }) => <Ionicons name="globe" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="mail"
        options={{
          title: 'Mail',
          tabBarIcon: ({ color, size }) => <Ionicons name="mail" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="files"
        options={{
          title: 'Dateien',
          tabBarIcon: ({ color, size }) => <Ionicons name="folder" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
