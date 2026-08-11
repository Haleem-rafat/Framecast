# Sound effects pack

Five short effects, layered onto every render by `src/lib/sfx-track.ts`: a
whoosh on each transition, a stinger at the start, a swell at the end.

## Licence

**None required.** These files are not sampled, purchased or downloaded from
anywhere — they are synthesised from scratch by FFmpeg's own signal generators
(`anoisesrc`, `aevalsrc`), which means there is no third party with a claim on
them and nothing to attribute. That is the whole reason they were produced this
way rather than sourced from a library.

Stock music is handled the opposite way, through the Jamendo API with a credit
in the description, because a music bed has to *vary* between videos. An effect
does not: the same whoosh plays on every cut of every video, so its licence is
worth settling once, permanently.

## How they were made

Reproduce or re-tune any of them by re-running the matching command from the
repository root. Nothing in the app regenerates these at runtime.

```bash
cd public/sfx

# Whooshes — filtered noise with a flanger and a symmetric fade, one per
# colour of noise so the three are audibly distinct as the rotation cycles.
ffmpeg -y -f lavfi -i "anoisesrc=d=0.55:c=pink:a=0.7:r=44100" \
  -af "highpass=f=250,lowpass=f=6000,flanger=delay=6:depth=9:speed=1.6,afade=t=in:st=0:d=0.3,afade=t=out:st=0.25:d=0.3,volume=1.6" \
  -ac 2 -ar 44100 -b:a 128k whoosh-1.mp3

ffmpeg -y -f lavfi -i "anoisesrc=d=0.45:c=white:a=0.6:r=44100" \
  -af "highpass=f=600,lowpass=f=9000,flanger=delay=4:depth=6:speed=2.4,afade=t=in:st=0:d=0.22,afade=t=out:st=0.2:d=0.25,volume=1.5" \
  -ac 2 -ar 44100 -b:a 128k whoosh-2.mp3

ffmpeg -y -f lavfi -i "anoisesrc=d=0.7:c=brown:a=0.8:r=44100" \
  -af "highpass=f=150,lowpass=f=3500,flanger=delay=8:depth=9:speed=1.1,afade=t=in:st=0:d=0.4,afade=t=out:st=0.35:d=0.35,volume=1.7" \
  -ac 2 -ar 44100 -b:a 128k whoosh-3.mp3

# Stinger — a C major chord with its harmonics, decaying fast, with a short
# echo so it reads as an accent rather than a beep.
ffmpeg -y -f lavfi -i "aevalsrc='0.35*sin(2*PI*523.25*t)+0.25*sin(2*PI*659.25*t)+0.18*sin(2*PI*783.99*t)+0.10*sin(2*PI*1046.5*t):d=1.4:s=44100'" \
  -af "afade=t=out:st=0.08:d=1.3,aecho=0.8:0.7:60:0.4,volume=1.2" \
  -ac 2 -ar 44100 -b:a 128k stinger.mp3

# Swell — a low triad under pink noise, rising over three seconds.
ffmpeg -y -f lavfi -i "aevalsrc='0.22*sin(2*PI*130.81*t)+0.16*sin(2*PI*196*t)+0.10*sin(2*PI*261.63*t):d=3.0:s=44100'" \
  -f lavfi -i "anoisesrc=d=3.0:c=pink:a=0.25:r=44100" \
  -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0,lowpass=f=2500,afade=t=in:st=0:d=2.2,afade=t=out:st=2.5:d=0.5,volume=1.3[a]" \
  -map "[a]" -ac 2 -ar 44100 -b:a 128k swell.mp3
```

`flanger`'s `depth` is capped at 10 by FFmpeg; a higher value fails the build
of the file rather than clamping.

## Replacing them

Swap in real recorded effects by overwriting these filenames — nothing reads
their contents, only their names, which are listed in `src/lib/sfx-track.ts`.
If you do, record the source and licence here, and add the credit to
`buildDescription` in `src/services/publish.service.ts` the way the Pixabay and
Jamendo credits already are.
