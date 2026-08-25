package com.mcbotai.client;

import net.minecraft.client.Minecraft;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Properties;

public class McBotAIConfig {

    private static final File CONFIG_FILE =
            new File(Minecraft.getInstance().gameDirectory, "config/mcbotai.properties");

    public static String host = "";
    public static String port = "25565";
    public static String username = "Botie";
    public static String masters = "";

    public static void load() {

        if (!CONFIG_FILE.isFile()) {
            return;
        }

        Properties properties = new Properties();

        try (FileInputStream input = new FileInputStream(CONFIG_FILE)) {

            properties.load(input);

            host = properties.getProperty("host", host);
            port = properties.getProperty("port", port);
            username = properties.getProperty("username", username);
            masters = properties.getProperty("masters", masters);

        } catch (IOException ignored) {
        }
    }

    public static void save() {

        File parent = CONFIG_FILE.getParentFile();

        if (!parent.exists()) {
            parent.mkdirs();
        }

        Properties properties = new Properties();

        properties.setProperty("host", host);
        properties.setProperty("port", port);
        properties.setProperty("username", username);
        properties.setProperty("masters", masters);

        try (FileOutputStream output = new FileOutputStream(CONFIG_FILE)) {

            properties.store(output, "McBotAI Configuration");

        } catch (IOException ignored) {
        }
    }
}