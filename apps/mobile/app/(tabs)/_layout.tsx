import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View } from "react-native";

import { AppBar } from "../../src/ui/AppBar";
import { useTheme } from "../../src/ui/theme";

export default function TabsLayout() {
  const theme = useTheme();

  return (
    /*
      The bar sits outside the navigator so there is one of it rather than one
      per tab: it keeps its state across a tab change and does not re-render
      when the screen under it does.
    */
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <AppBar />
      <Tabs
        screenOptions={{
          headerShown: false,
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
            title: "Übersicht",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="pulse" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="services"
          options={{
            title: "Services",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="layers" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="web"
          options={{
            title: "Web",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="globe" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="mail"
          options={{
            title: "Mail",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="mail" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="files"
          options={{
            title: "Dateien",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="folder" color={color} size={size} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}
