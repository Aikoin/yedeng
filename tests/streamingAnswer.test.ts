import {afterEach,expect,it,vi} from 'vitest';
import {createStreamingAnswer,streamingPreview} from '../src/viewer/streamingAnswer';
afterEach(()=>vi.useRealTimers());
it('batches many deltas into one formatted update and never loses their order',()=>{
 vi.useFakeTimers();const paint=vi.fn(),stream=createStreamingAnswer(paint);
 stream.push('**hello');stream.push(' world**');expect(paint).not.toHaveBeenCalled();vi.advanceTimersByTime(120);expect(paint).toHaveBeenCalledExactlyOnceWith('**hello world**');
 stream.push('\n\n> quote');vi.advanceTimersByTime(120);expect(paint).toHaveBeenLastCalledWith('**hello world**\n\n> quote');
});
it('pending paint cannot overwrite a completed answer or cancelled error',()=>{
 vi.useFakeTimers();const paint=vi.fn(),stream=createStreamingAnswer(paint);stream.push('partial');stream.stop();vi.runAllTimers();stream.push('late');vi.runAllTimers();expect(paint).not.toHaveBeenCalled();
});
it('holds incomplete equation and citation markers until complete',()=>{
 expect(streamingPreview('Text [E')).toBe('Text ');expect(streamingPreview('Text [E12]')).toBe('Text [E12]');
 expect(streamingPreview('Answer\n$$\\sum_')).toContain('公式生成中');expect(streamingPreview('$$x^2$$')).toBe('$$x^2$$');
 expect(streamingPreview('```text\n$$code')).toBe('```text\n$$code');
 expect(streamingPreview('$$\nx\n$$')).toBe('$$\nx\n$$');
});
