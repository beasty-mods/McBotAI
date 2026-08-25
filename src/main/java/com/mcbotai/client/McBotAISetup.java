package com.mcbotai.client;

import net.minecraft.client.Minecraft;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URISyntaxException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

/**
 * Locates and extracts the bundled node.exe runtime + bot source that ship
 * with this mod under src/main/resources/mcbotai (packaged inside the mod
 * jar automatically by Gradle's default resources source set).
 *
 * NOTE ON PREVIOUS BROKEN APPROACHES, for anyone reading this later:
 *
 *  1. This originally used this class's own
 *     getProtectionDomain().getCodeSource() to find the mod's jar. Under
 *     Forge's ModLauncher that returns a CodeSource with a null location
 *     (it uses its own transforming classloader, not a plain
 *     URLClassLoader), which crashed with a bare NullPointerException.
 *
 *  2. That got "fixed" by building paths directly off the game
 *     directory's parent folder. That only worked when running via
 *     Gradle's runClient from inside the project's own source tree - it
 *     broke the moment the actual built jar was installed into a real
 *     .minecraft/mods folder, since gameDirectory's parent there has
 *     nothing to do with the project source tree.
 *
 *  3. That got "fixed" with ModList.getModFileById(...) + ModFileInfo -
 *     except ModFileInfo isn't actually in net.minecraftforge.fml in this
 *     Forge version (or the exact class/package was just wrong), so it
 *     didn't compile.
 *
 *  4. That got "fixed" with ClassLoader#getResource() + JarURLConnection,
 *     assuming a standard "jar:file:...!/entry" URL. Except Forge's
 *     ModLauncher doesn't hand back "jar:" or "file:" URLs for a mod's own
 *     resources at all - it uses its own custom "modjar://" scheme
 *     (cpw.mods.jarhandling's virtual filesystem), which JarURLConnection
 *     can't parse. That's the "Unexpected resource URL protocol modjar"
 *     error.
 *
 * This version sidesteps Forge's resource-URL scheme entirely: it scans
 * the real .minecraft/mods folder directly on disk and opens whichever
 * jar there actually contains this resource using plain java.util.zip -
 * completely standard Java, nothing Forge-specific, so it doesn't matter
 * what internal URL scheme ModLauncher happens to use this version. The
 * classloader/getResource() route is kept only as a fallback for the
 * Gradle dev environment, where there's no mods/ folder to scan and
 * resources genuinely are plain files on disk.
 */
public class McBotAISetup {

    private static final String RUNTIME_RESOURCE_PATH = "mcbotai/runtime";
    private static final String BOT_RESOURCE_PATH = "mcbotai/bot";

    public static File getBotDir() {
        return new File(Minecraft.getInstance().gameDirectory, "config/mcbotai/bot");
    }

    public static File getRuntimeDir() {
        return new File(Minecraft.getInstance().gameDirectory, "config/mcbotai/runtime");
    }

    public static File getNodeExecutable() {
        return new File(getRuntimeDir(), "node.exe");
    }

    public static File getNpmCliJs() {
        return new File(getRuntimeDir(), "node_modules/npm/bin/npm-cli.js");
    }

    /**
     * Extracts the bundled runtime/ (node.exe + npm) into
     * config/mcbotai/runtime if it isn't there already - skipped on
     * repeat calls once node.exe exists, so re-running Setup doesn't
     * re-copy the ~85MB runtime every time - and refreshes the bot/
     * template into config/mcbotai/bot.
     */
    public static void copyBotToConfig() throws IOException {
        if (!getNodeExecutable().isFile()) {
            extractBundledResources(RUNTIME_RESOURCE_PATH, getRuntimeDir());
        }

        File botDir = getBotDir();
        botDir.mkdirs();
        extractBundledResources(BOT_RESOURCE_PATH, botDir);
    }

    private static void extractBundledResources(String resourcePath, File targetDir) throws IOException {

        File modJarOnDisk = findModsFolderJarContaining(resourcePath);
        if (modJarOnDisk != null) {
            extractFromJarFile(modJarOnDisk, resourcePath, targetDir);
            return;
        }

        // Fallback for the Gradle dev environment (runClient), where
        // there's no mods/ folder at all and resources sit as plain files
        // on disk instead of packed into a jar.
        URL url = McBotAISetup.class.getClassLoader().getResource(resourcePath);
        if (url == null) {
            throw new IOException("Bundled resource not found: " + resourcePath
                    + " - not present in any jar under the mods folder, and not found on the classpath either.");
        }
        if (!"file".equals(url.getProtocol())) {
            throw new IOException("Couldn't read bundled resource \"" + resourcePath
                    + "\" - no matching jar found under the mods folder, and the classloader returned an "
                    + "unsupported URL protocol \"" + url.getProtocol() + "\" (" + url + ").");
        }

        File sourceDir;
        try {
            sourceDir = new File(url.toURI());
        } catch (URISyntaxException e) {
            sourceDir = new File(url.getPath());
        }
        if (!sourceDir.isDirectory()) {
            throw new IOException("Expected a directory of bundled resources at " + sourceDir);
        }
        copyDirectory(sourceDir.toPath(), targetDir.toPath());
    }

    /**
     * Scans every jar in the real .minecraft/mods folder (plain
     * java.util.zip access, nothing Forge-specific - avoids ModLauncher's
     * custom URL schemes entirely) and returns whichever one actually
     * contains this resource path.
     */
    private static File findModsFolderJarContaining(String resourcePath) {
        File modsDir = new File(Minecraft.getInstance().gameDirectory, "mods");
        File[] jars = modsDir.listFiles((dir, name) -> name.toLowerCase().endsWith(".jar"));
        if (jars == null) {
            return null;
        }

        String entryPrefix = resourcePath.endsWith("/") ? resourcePath : resourcePath + "/";

        for (File jarFileOnDisk : jars) {
            try (JarFile jarFile = new JarFile(jarFileOnDisk)) {
                Enumeration<JarEntry> jarEntries = jarFile.entries();
                while (jarEntries.hasMoreElements()) {
                    if (jarEntries.nextElement().getName().startsWith(entryPrefix)) {
                        return jarFileOnDisk;
                    }
                }
            } catch (IOException ignored) {
                // Not a readable jar (or not ours) - just move on to the next one.
            }
        }
        return null;
    }

    private static void extractFromJarFile(File jarFileOnDisk, String resourcePath, File targetDir) throws IOException {
        String entryPrefix = resourcePath.endsWith("/") ? resourcePath : resourcePath + "/";

        try (JarFile jarFile = new JarFile(jarFileOnDisk)) {
            Enumeration<JarEntry> jarEntries = jarFile.entries();
            while (jarEntries.hasMoreElements()) {
                JarEntry entry = jarEntries.nextElement();
                String name = entry.getName();

                if (!name.startsWith(entryPrefix) || name.equals(entryPrefix)) {
                    continue;
                }

                File outFile = new File(targetDir, name.substring(entryPrefix.length()));

                if (entry.isDirectory()) {
                    outFile.mkdirs();
                    continue;
                }

                File parent = outFile.getParentFile();
                if (parent != null) {
                    parent.mkdirs();
                }

                try (InputStream in = jarFile.getInputStream(entry);
                     FileOutputStream out = new FileOutputStream(outFile)) {
                    byte[] buffer = new byte[8192];
                    int len;
                    while ((len = in.read(buffer)) != -1) {
                        out.write(buffer, 0, len);
                    }
                }
            }
        }
    }

    private static void copyDirectory(Path source, Path target) throws IOException {
        try {
            Files.walk(source).forEach(path -> {
                try {
                    Path dest = target.resolve(source.relativize(path));
                    if (Files.isDirectory(path)) {
                        Files.createDirectories(dest);
                    } else {
                        Files.createDirectories(dest.getParent());
                        Files.copy(path, dest, StandardCopyOption.REPLACE_EXISTING);
                    }
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
    }
}
